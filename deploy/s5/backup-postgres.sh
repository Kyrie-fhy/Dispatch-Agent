#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 2 ]; then
  printf 'Usage: %s DATABASE ABSOLUTE_BACKUP_DIR\n' "$0" >&2
  exit 2
fi
database=$1
backup_dir=$2
case "$database" in
  ''|*[!a-zA-Z0-9_-]*) printf 'Invalid database name\n' >&2; exit 2 ;;
esac
case "$backup_dir" in
  /*) ;;
  *) printf 'Backup directory must be an absolute path\n' >&2; exit 2 ;;
esac
if [ -L "$backup_dir" ]; then
  printf 'Backup directory must not be a symbolic link\n' >&2
  exit 2
fi
mkdir -p "$backup_dir"
chmod 0700 "$backup_dir"
archive="$backup_dir/$database-$(date -u +%F).dump"
if [ -L "$archive" ] || { [ -e "$archive" ] && [ ! -f "$archive" ]; }; then
  printf 'Backup path must be a regular file: %s\n' "$archive" >&2
  exit 2
fi

if [ ! -f "$archive" ]; then
  temporary=$(mktemp "$backup_dir/.$database.XXXXXXXX")
  trap 'rm -f "$temporary"' EXIT
  trap 'exit 1' HUP INT TERM
  pg_dump --no-password --format=custom --dbname="$database" --file="$temporary"
  pg_restore --list "$temporary" >/dev/null
  # Publish atomically without replacing another completed backup for the same date.
  if ! ln "$temporary" "$archive"; then
    [ -f "$archive" ] || exit 1
  fi
fi

find "$backup_dir" -maxdepth 1 -type f \
  -name "$database-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].dump" -mtime +13 -exec rm -f {} +
printf 'Backup available at %s\n' "$archive"
