import { createHash, randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { Material, materialChunkBytes, materialDigestPattern, materialImagePattern, materialMaxBytes,
  MaterialSource } from '../miniprogram/core/materials';
import { missingDraft, readAccount, readWorkspace, Workspace, writeAccount } from './account-workspace';
import { setAccount, transaction } from './database';
import { HttpError } from './http-error';
import { readCommand, readId, validRevision } from './request-input';

type MaterialRow = MaterialSource & Pick<Material, 'id' | 'received' | 'organized'>;
const columns = `id, request_id AS "requestId", draft_id AS "draftId", revision, name, size, digest, received,
  EXISTS (SELECT 1 FROM dispatch.image_order_inputs i
    WHERE i.account_id = m.account_id AND i.draft_id = m.draft_id AND i.image_digest = m.digest) AS organized`;

export function readMaterialInput(value: unknown): MaterialSource {
  const body = readCommand(value);
  const draftId = readId(body.draftId, '草稿编号');
  const { requestId, revision, size, digest } = body;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!validRevision(revision) || !name || name.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(name)
      || Buffer.from(name).toString() !== name || !materialImagePattern.test(name)
      || typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > materialMaxBytes
      || typeof digest !== 'string' || !materialDigestPattern.test(digest)) {
    throw new HttpError(400, 'invalid_material', '请选择不超过 10 MB 的 JPG、PNG、WebP 或 HEIC 图片');
  }
  return { requestId, draftId, revision, name, size, digest };
}

function details(row: MaterialRow, workspace: Workspace): Material {
  return { ...row, status: row.received === row.size ? 'ready' : 'uploading',
    draftCurrent: workspace.id === row.draftId && workspace.revision === row.revision && workspace.currentTripId !== row.draftId };
}

async function findMaterial(client: PoolClient, accountId: string, id: string, lock = false): Promise<MaterialRow> {
  const { rows: [row] } = await client.query<MaterialRow>(
    `SELECT ${columns} FROM dispatch.materials m WHERE account_id = $1 AND id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [accountId, id]);
  if (!row) throw new HttpError(404, 'material_not_found', '未找到材料');
  return row;
}

export async function readOrderImage(client: PoolClient, accountId: string, draftId: string, id: string) {
  const material = await findMaterial(client, accountId, id);
  if (material.draftId !== draftId) throw new HttpError(404, 'material_not_found', '这张图片不属于当前趟');
  if (material.received !== material.size) throw new HttpError(409, 'material_incomplete', '请先完成图片上传');
  if (material.organized) throw new HttpError(409, 'duplicate_order_image', '这张图片已整理到本趟草稿，请核对原明细。');
  const { rows } = await client.query<{ content: Buffer }>(`
    SELECT content FROM dispatch.material_chunks WHERE account_id = $1 AND material_id = $2 ORDER BY byte_offset
  `, [accountId, id]);
  const content = Buffer.concat(rows.map(row => row.content));
  const mime = imageMime(content);
  if (!mime) {
    throw new HttpError(422, 'unsupported_order_image', '请选择 JPG、PNG 或 WebP 图片。HEIC 可以转存为 JPG 后重新上传，也可以手动录入。');
  }
  return { content, mime, digest: material.digest };
}

export function imageMime(content: Buffer): string | undefined {
  if (content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (content.toString('ascii', 0, 4) === 'RIFF' && content.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}

export class MaterialStore {
  constructor(private readonly pool: Pool) {}

  async begin(accountId: string, input: MaterialSource) {
    const { requestId, draftId, revision, name, size, digest } = input;
    const id = await writeAccount(this.pool, accountId, requestId, { action: 'begin-material', draftId, revision, name, size, digest },
      async (client, workspace) => {
        if (workspace.id !== draftId) throw missingDraft();
        if (workspace.revision !== revision || workspace.currentTripId === draftId) {
          throw new HttpError(409, 'material_draft_changed', '草稿已更新或确认，请刷新草稿后重新选择文件');
        }
        const id = randomUUID();
        await client.query(`INSERT INTO dispatch.materials (account_id, id, request_id, draft_id, revision, name, size, digest)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [accountId, id, requestId, draftId, revision, name, size, digest]);
        return id;
      });
    return this.read(accountId, id);
  }

  list(accountId: string) {
    return readAccount(this.pool, accountId, async client => {
      const workspace = await readWorkspace(client, accountId);
      const { rows } = await client.query<MaterialRow>(
        `SELECT ${columns} FROM dispatch.materials m WHERE account_id = $1 ORDER BY created_at DESC, id DESC`, [accountId]);
      return rows.map(row => details(row, workspace));
    });
  }

  read(accountId: string, id: string) {
    return readAccount(this.pool, accountId, async client =>
      details(await findMaterial(client, accountId, id), await readWorkspace(client, accountId)));
  }

  append(accountId: string, id: string, offset: number, content: Buffer) {
    return transaction(this.pool, async client => {
      await setAccount(client, accountId);
      const row = await findMaterial(client, accountId, id, true);
      if (offset < 0 || offset % materialChunkBytes !== 0 || offset >= row.size ||
          content.length !== Math.min(materialChunkBytes, row.size - offset)) {
        throw new HttpError(400, 'invalid_chunk', '文件分块大小或位置无效');
      }
      if (offset > row.received) throw new HttpError(409, 'material_offset', '上传位置已变化，请重新读取进度');
      if (offset < row.received) {
        const { rows: [previous] } = await client.query<{ content: Buffer }>(`
          SELECT content FROM dispatch.material_chunks WHERE account_id = $1 AND material_id = $2 AND byte_offset = $3
        `, [accountId, id, offset]);
        if (!previous?.content.equals(content)) throw new HttpError(409, 'material_chunk_conflict', '文件与已上传分块不匹配');
        return details(row, await readWorkspace(client, accountId));
      }

      await client.query(`INSERT INTO dispatch.material_chunks (account_id, material_id, byte_offset, content)
        VALUES ($1, $2, $3, $4)`, [accountId, id, offset, content]);
      const received = offset + content.length;
      if (received === row.size) {
        const { rows } = await client.query<{ content: Buffer }>(`
          SELECT content FROM dispatch.material_chunks WHERE account_id = $1 AND material_id = $2 ORDER BY byte_offset
        `, [accountId, id]);
        const hash = createHash('sha256');
        for (const chunk of rows) hash.update(chunk.content);
        if (hash.digest('hex') !== row.digest) throw new HttpError(409, 'material_digest', '文件校验失败，请重新选择原文件');
      }
      await client.query('UPDATE dispatch.materials SET received = $3 WHERE account_id = $1 AND id = $2',
        [accountId, id, received]);
      return details({ ...row, received }, await readWorkspace(client, accountId));
    });
  }
}
