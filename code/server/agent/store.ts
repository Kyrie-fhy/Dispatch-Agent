import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import type { AgentEvent, AgentStatus, AgentTurn, DirectIntent, Question } from '../../miniprogram/core/agent';
import { isObject } from '../../miniprogram/core/orders';
import { textOrderLimit } from '../../miniprogram/core/text-order';
import type { TripDraft } from '../../miniprogram/core/trips';
import { missingDraft, readAccount, readWorkspace, Workspace, workspaceDraft, writeAccount } from '../account-workspace';
import { setAccount, transaction } from '../database';
import { HttpError } from '../http-error';
import { readId, readPreviewInput, validRevision } from '../request-input';
import { readable } from '../text-orders';
import type { PreviousQuestions } from './edit';

export function readTurnInput(value: unknown) {
  const basis = readPreviewInput(value);
  const { text = '', materialIds = [], direct: rawDirect } = value as Record<string, unknown>;
  let direct: DirectIntent | undefined;
  if (rawDirect !== undefined) {
    if (!isObject(rawDirect)) throw invalidIntent();
    if (rawDirect.intent === 'preview' && Object.keys(rawDirect).length === 1) direct = { intent: 'preview' };
    else if (rawDirect.intent === 'draft' && Object.keys(rawDirect).length === 3 &&
      readable(rawDirect.answer, 100) && rawDirect.answer.trim() && rawDirect.answer === text) {
      direct = { intent: 'draft', turnId: readId(rawDirect.turnId, '问题回合编号'), answer: rawDirect.answer };
    } else throw invalidIntent();
  }
  if (direct && Array.isArray(materialIds) && materialIds.length) throw invalidIntent();
  if (!readable(text, textOrderLimit) || !Array.isArray(materialIds) || materialIds.length > 4 || (!direct && !text.trim() && !materialIds.length)) {
    throw new HttpError(400, 'invalid_agent_message', '请输入文字或选择最多 4 张已上传的图片');
  }
  const images = materialIds.map(id => readId(id, '图片编号'));
  if (new Set(images).size !== images.length) throw new HttpError(400, 'invalid_agent_message', '请移除重复图片');
  return { ...basis, text: direct?.intent === 'preview' ? '生成送货单' : text.trim(), materialIds: images, ...(direct ? { direct } : {}) };
}

function invalidIntent() {
  return new HttpError(400, 'invalid_agent_intent', '这个选项无效，请从最新问题重新选择。');
}

export const cardActions = new Set(['answer', 'undo', 'confirm', 'edit', 'picking', 'next', 'workspace', 'retry']);
export type Input = ReturnType<typeof readTurnInput>;
export type TurnKey = { account: string; id: string; draftId: string };
type StoredTurn = {
  draftId: string; startRevision: number; endRevision: number; before: TripDraft['customers']; status: AgentStatus; undone: boolean;
};

export function checkDraft(workspace: Workspace, draftId: string, revision: number, increment = false) {
  if (workspace.id !== draftId || workspace.revision !== revision) {
    throw new HttpError(409, 'draft_changed', '草稿已更新或换趟，请核对最新草稿后重试。');
  }
  if (workspace.currentTripId === draftId) throw new HttpError(409, 'draft_confirmed', '本趟已确认，请查看正式单。');
  if (increment && !validRevision(revision, true)) throw new HttpError(409, 'draft_revision_limit', '草稿已达到修订上限');
}

export async function event(client: PoolClient, key: TurnKey, kind: string, payload: object) {
  await client.query(`INSERT INTO dispatch.agent_events (account_id, draft_id, turn_id, kind, payload)
    VALUES ($1, $2, $3, $4, $5)`, [key.account, key.draftId, key.id, kind, JSON.stringify(payload)]);
}

async function getTurn(client: PoolClient, account: string, id: string, lock = false): Promise<StoredTurn> {
  const { rows: [turn] } = await client.query<StoredTurn>(`
    SELECT draft_id AS "draftId", start_revision AS "startRevision", end_revision AS "endRevision",
      before_customers AS "before", status, undone
    FROM dispatch.agent_turns WHERE account_id = $1 AND id = $2 ${lock ? 'FOR UPDATE' : ''}`, [account, id]);
  if (!turn) throw new HttpError(404, 'turn_not_found', '未找到这条消息');
  return turn;
}

export async function saveChange(client: PoolClient, key: TurnKey, revision: number, lines: string[], signal: AbortSignal, digest?: string) {
  signal.throwIfAborted();
  const changed = await client.query(`UPDATE dispatch.agent_turns SET end_revision = $3
    WHERE account_id = $1 AND id = $2 AND status = 'running' AND end_revision = $3::int - 1`, [key.account, key.id, revision]);
  if (changed.rowCount !== 1) throw new HttpError(409, 'turn_ended', '本轮已结束，请重新发送。');
  await event(client, key, 'change', { lines });
  if (digest) await event(client, key, 'image_applied', { digest });
  signal.throwIfAborted();
}

async function visibleEvents(client: PoolClient, account: string, id: string, after: number) {
  const { rows } = await client.query<AgentEvent>(`
    SELECT seq::float8, kind, payload FROM dispatch.agent_events
    WHERE account_id = $1 AND turn_id = $2 AND seq > $3
      AND kind IN ('progress', 'plan', 'step', 'questions', 'preview', 'change', 'undo', 'end') ORDER BY seq`, [account, id, after]);
  return rows;
}

async function endTurn(client: PoolClient, key: TurnKey, status: Exclude<AgentStatus, 'running'>, text: string, errorCode?: string) {
  const turn = await getTurn(client, key.account, key.id, true);
  if (turn.status !== 'running') return;
  const changed = turn.endRevision !== turn.startRevision;
  const message = status === 'completed' ? text : `${text}${changed ? '已保存的草稿改动仍在。' : '草稿没有变化。'}`;
  await client.query('UPDATE dispatch.agent_turns SET status = $3 WHERE account_id = $1 AND id = $2',
    [key.account, key.id, status]);
  await client.query(`INSERT INTO dispatch.agent_messages (account_id, turn_id, role, content)
    VALUES ($1, $2, 'assistant', $3)`, [key.account, key.id, message]);
  const { rows: [timing] } = await client.query<{ elapsedMs: number }>(
    'SELECT greatest(0, round(extract(epoch FROM clock_timestamp() - created_at) * 1000))::float8 AS "elapsedMs" FROM dispatch.agent_turns WHERE account_id = $1 AND id = $2',
    [key.account, key.id]);
  await event(client, key, 'end', { status, text: message, revision: turn.endRevision, errorCode, elapsedMs: timing.elapsedMs });
}

async function previousQuestions(client: PoolClient, account: string, draftId: string, revision: number, exclude?: string) {
  const { rows: [previous] } = await client.query<PreviousQuestions>(`
    SELECT t.id AS "turnId", m.content AS text, e.payload, confirmation.payload AS confirmation
    FROM dispatch.agent_turns t JOIN dispatch.agent_messages m
      ON m.account_id = t.account_id AND m.turn_id = t.id AND m.role = 'user'
    JOIN dispatch.agent_events e ON e.account_id = t.account_id AND e.turn_id = t.id AND e.kind = 'questions'
    LEFT JOIN dispatch.agent_events confirmation
      ON confirmation.account_id = t.account_id AND confirmation.turn_id = t.id AND confirmation.kind = 'edit_confirmation'
    WHERE t.account_id = $1 AND t.end_revision = $4 AND NOT t.undone AND t.status = 'completed'
      AND t.id = (SELECT id FROM dispatch.agent_turns WHERE account_id = $1 AND draft_id = $2
        AND ($3::uuid IS NULL OR id <> $3) ORDER BY created_at DESC, id DESC LIMIT 1)
    ORDER BY e.seq DESC LIMIT 1`, [account, draftId, exclude ?? null, revision]);
  return previous;
}

export class AgentStore {
  constructor(private readonly pool: Pool) {}

  start(account: string, input: Input, reserve: () => void) {
    const { requestId, ...command } = input;
    return writeAccount(this.pool, account, requestId, { action: 'agent-turn', ...command }, async (client, workspace) => {
      const { draftId, revision, text, materialIds } = input;
      if (workspace.id !== draftId) throw missingDraft();
      if (workspace.currentTripId === draftId) {
        if (materialIds.length || workspace.revision !== revision) {
          throw new HttpError(409, 'draft_confirmed', '本趟已确认，请开始下一趟或查看取货清单。');
        }
      } else checkDraft(workspace, draftId, revision);
      if (input.direct?.intent === 'draft') {
        const prior = await previousQuestions(client, account, draftId, revision);
        const { turnId, answer } = input.direct;
        if (prior?.turnId !== turnId || !prior.payload.questions.some(question => question.options.includes(answer))) {
          throw invalidIntent();
        }
      }
      reserve();
      const active = await client.query(`SELECT 1 FROM dispatch.agent_turns WHERE account_id = $1 AND status = 'running'`, [account]);
      if (active.rowCount) throw new HttpError(429, 'agent_busy', '上一条消息正在处理，请稍等。');
      if (materialIds.length) {
        const ready = await client.query(`SELECT id FROM dispatch.materials
          WHERE account_id = $1 AND draft_id = $2 AND id = ANY($3::uuid[]) AND received = size`, [account, draftId, materialIds]);
        if (ready.rowCount !== materialIds.length) throw new HttpError(409, 'material_incomplete', '请检查图片是否已上传到当前趟。');
      }
      const id = randomUUID();
      await client.query(`INSERT INTO dispatch.agent_turns
        (account_id, id, draft_id, start_revision, end_revision, before_customers, status)
        VALUES ($1, $2, $3, $4, $4, $5, 'running')`,
      [account, id, draftId, revision, JSON.stringify(workspaceDraft(workspace).customers)]);
      await client.query(`INSERT INTO dispatch.agent_messages (account_id, turn_id, role, content, material_ids)
        VALUES ($1, $2, 'user', $3, $4)`, [account, id, text, materialIds]);
      await event(client, { account, draftId, id }, 'submitted', { textLength: text.length, images: materialIds.length });
      return { turnId: id };
    });
  }

  events(account: string, id: string, after: number) {
    return readAccount(this.pool, account, async client => {
      const { status } = await getTurn(client, account, id);
      return { status, events: await visibleEvents(client, account, id, after) };
    });
  }

  conversation(account: string) {
    return readAccount(this.pool, account, async client => {
      const workspace = await readWorkspace(client, account);
      const { rows } = await client.query<Omit<AgentTurn, 'events'>>(`
        SELECT t.id, t.status, t.start_revision AS revision, m.content AS text, m.material_ids AS "materialIds"
        FROM dispatch.agent_turns t JOIN dispatch.agent_messages m ON m.account_id = t.account_id AND m.turn_id = t.id
        WHERE t.account_id = $1 AND t.draft_id = $2 AND m.role = 'user'
        ORDER BY t.created_at DESC, t.id DESC LIMIT 60`, [account, workspace.id]);
      const turns: AgentTurn[] = [];
      for (const row of rows.reverse()) turns.push({ ...row, events: await visibleEvents(client, account, row.id, 0) });
      const draftConfirmed = workspace.currentTripId === workspace.id;
      const issued = draftConfirmed ? await client.query<{ id: string }>(
        'SELECT source_preview_id AS id FROM dispatch.trips WHERE account_id = $1 AND id = $2', [account, workspace.id]) : null;
      return { draftId: workspace.id, revision: workspace.revision, turns, draft: workspaceDraft(workspace),
        draftConfirmed, confirmedPreviewId: issued?.rows[0]?.id ?? null };
    });
  }

  context(key: TurnKey, revision: number) {
    return readAccount(this.pool, key.account, async client => {
      const workspace = await readWorkspace(client, key.account);
      if (workspace.id !== key.draftId || workspace.revision !== revision) checkDraft(workspace, key.draftId, revision);
      const { rows: [last] } = await client.query<{ seen: boolean; changed: boolean; asked: boolean; previewed: boolean }>(`
        SELECT count(*) > 0 AS seen, coalesce(bool_or(e.kind = 'change'), false) AS changed,
          coalesce(bool_or(e.kind = 'questions'), false) AS asked,
          coalesce(bool_or(e.kind = 'preview'), false) AS previewed
        FROM dispatch.agent_events e WHERE e.account_id = $1 AND e.turn_id = (
          SELECT id FROM dispatch.agent_turns WHERE account_id = $1 AND draft_id = $2 AND id <> $3
          ORDER BY created_at DESC, id DESC LIMIT 1
        )`, [key.account, key.draftId, key.id]);
      const previous = await previousQuestions(client, key.account, key.draftId, revision, key.id);
      const lastSummary = previous && last.asked ? '有草稿问题待确认。' : last.previewed ? '已生成送货单预览。'
        : last.changed ? '本趟草稿已整理。' : last.seen ? '草稿没有变化。' : '';
      return { draft: workspaceDraft(workspace), previous, lastSummary };
    });
  }

  append(key: TurnKey, kind: string, payload: object) {
    return transaction(this.pool, async client => {
      await setAccount(client, key.account);
      const turn = await getTurn(client, key.account, key.id, true);
      if (turn.status === 'running') await event(client, key, kind, payload);
    });
  }

  finish(key: TurnKey, status: Exclude<AgentStatus, 'running'>, text: string, errorCode?: string) {
    return transaction(this.pool, async client => {
      await setAccount(client, key.account);
      await endTurn(client, key, status, text, errorCode);
    });
  }

  async interrupt() {
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM dispatch.accounts');
    for (const { id: account } of rows) {
      await transaction(this.pool, async client => {
        await setAccount(client, account);
        const { rows: running } = await client.query<{ id: string; draft_id: string }>(
          "SELECT id, draft_id FROM dispatch.agent_turns WHERE account_id = $1 AND status = 'running'", [account]);
        for (const turn of running) {
          const key = { account, draftId: turn.draft_id, id: turn.id };
          const { rows: [step] } = await client.query<{ id: string; state: string }>(`
            SELECT payload->>'id' AS id, payload->>'state' AS state FROM dispatch.agent_events
            WHERE account_id = $1 AND turn_id = $2 AND kind = 'step' ORDER BY seq DESC LIMIT 1`, [account, turn.id]);
          if (step?.state === 'running') await event(client, key, 'step',
            { id: step.id, state: 'failed', result: '服务重启，处理已中断。' });
          await endTurn(client, key, 'interrupted', '服务重启，上一轮已中断，可以重试。');
        }
      });
    }
  }

  undo(account: string, id: string, requestId: string) {
    return writeAccount(this.pool, account, requestId, { action: 'agent-undo', turnId: id }, async (client, workspace) => {
      const turn = await getTurn(client, account, id, true);
      if (turn.status === 'running' || turn.undone || turn.startRevision === turn.endRevision) {
        throw new HttpError(409, 'undo_unavailable', '这一步当前无法撤销。');
      }
      checkDraft(workspace, turn.draftId, turn.endRevision, true);
      const revision = workspace.revision + 1;
      await client.query('UPDATE dispatch.workspaces SET draft_revision = $2, draft_customers = $3 WHERE account_id = $1',
        [account, revision, JSON.stringify(turn.before)]);
      await client.query(`DELETE FROM dispatch.image_order_inputs WHERE account_id = $1 AND draft_id = $2 AND image_digest IN (
        SELECT payload->>'digest' FROM dispatch.agent_events WHERE account_id = $1 AND turn_id = $3 AND kind = 'image_applied'
      )`, [account, turn.draftId, id]);
      await client.query('UPDATE dispatch.agent_turns SET undone = true WHERE account_id = $1 AND id = $2', [account, id]);
      await event(client, { account, draftId: turn.draftId, id }, 'undo', { revision });
      return { revision };
    });
  }

  card(account: string, value: unknown) {
    const basis = readPreviewInput(value);
    if (!isObject(value) || typeof value.action !== 'string' || !cardActions.has(value.action)) {
      throw new HttpError(400, 'invalid_card_action', '卡片操作无效');
    }
    const action = value.action;
    const turnId = action === 'edit' && value.turnId !== undefined ? readId(value.turnId, '预览回合编号') : undefined;
    return writeAccount(this.pool, account, basis.requestId, { ...basis, action: 'agent-card', card: action, turnId }, async (client, workspace) => {
      if (workspace.id !== basis.draftId) {
        const previous = await client.query('SELECT 1 FROM dispatch.trips WHERE account_id = $1 AND id = $2',
          [account, basis.draftId]);
        if (!previous.rowCount) throw missingDraft();
      }
      if (turnId) {
        const turn = await getTurn(client, account, turnId);
        if (turn.draftId !== basis.draftId || turn.status !== 'completed') throw invalidIntent();
        const preview = await client.query(`SELECT 1 FROM dispatch.agent_events
          WHERE account_id = $1 AND turn_id = $2 AND kind = 'preview'`, [account, turnId]);
        if (!preview.rowCount) throw invalidIntent();
        await event(client, { account, id: turnId, draftId: basis.draftId }, 'step',
          { id: 'confirm', state: 'skipped', result: '修改完成后请重新生成预览。' });
      }
      await client.query(`INSERT INTO dispatch.agent_events (account_id, draft_id, kind, payload)
        VALUES ($1, $2, 'card', $3)`, [account, basis.draftId, JSON.stringify({ action })]);
      return { recorded: true };
    });
  }
}
