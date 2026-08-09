#!/bin/bash
# ポートフォリオ公開用スナップショット発行スクリプト
# Macのローカルサーバ(:8790)の /api/snapshot を取得し、snapshotブランチへ単一コミットでforce-push。
# Vercelの静的画面が raw.githubusercontent.com/.../snapshot/web/snapshot.json を読む。
# 数分毎に launchd(com.cryptoagentx.snapshot) が実行。実弾には一切触れない。
set -e
REPO="/Users/koretada/Desktop/仮想通貨_エージェント"
WT="$REPO/.snapshot-wt"
API="http://localhost:8790/api/snapshot"
export PATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# 1) スナップショット取得(サーバ生存時のみ更新。落ちていれば前回値を保持=画面は最後の実データを表示)
TMP="$(mktemp)"
if curl -fsS --max-time 15 "$API" -o "$TMP" 2>/dev/null && node -e "JSON.parse(require('fs').readFileSync('$TMP','utf8'))" 2>/dev/null; then
  mkdir -p "$WT/web"
  cp "$TMP" "$WT/web/snapshot.json"
else
  echo "$(date '+%F %T') サーバ応答なし/不正JSON→push skip"
  rm -f "$TMP"; exit 0
fi
rm -f "$TMP"

# 2) snapshotブランチに単一コミットで反映(履歴を肥大させないよう毎回amend+force-push)
cd "$WT"
git add web/snapshot.json
if git diff --cached --quiet; then echo "$(date '+%F %T') 差分なし→skip"; exit 0; fi
git commit --amend --no-edit --quiet 2>/dev/null || git commit -m "snapshot" --quiet
git push -f -q origin snapshot 2>/dev/null && echo "$(date '+%F %T') pushed" || echo "$(date '+%F %T') push失敗(ネット?)"
