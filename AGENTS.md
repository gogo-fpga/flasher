# AGENTS.md

Devin / Codex / Claude Code など、このリポジトリで作業するすべての AI エージェントと人間が守るルールです。

## 1. main ブランチ

- GitHub のルールセットで `main` を保護しています。直接 push せず、`<agent>/<short>` ブランチで作業して PR を作成します。
- エージェントは PR をマージしません。ルールセットやリポジトリの設定も変更しません。
- 作業前に `git branch --show-current` を確認し、`main` では作業しません。
- 誤って `main` にコミットした場合は push も reset もせず、新しいブランチに移して報告します。
- 先行する PR のマージ後は、`origin/main` から新しいブランチを切ります。

## 2. 言語と書式

- ドキュメント、Issue、Pull Request のタイトルと本文、コミットメッセージは日本語で書きます。Web 画面の文言も日本語です。
- コード、識別子、ファイル名、コマンドは英語のままにします。
- 日本語の文章を書いたら、推敲スキル「yomiyasu」で読みやすさを整えます（後述）。
- 追跡しているテキストファイルの文字は JIS X 0213:2004 の範囲に収めます。CI の `agent-docs` ワークフローが検査します。
- 範囲外の文字を残してよいのは、upstream 由来のファイルと原文の引用だけです。引用は原文を書き換えずにコードスパン・コードブロック・引用行（`>`）で囲み、`.github/jisx0213-allowlist.tsv` に理由を一行で書きます。手順は「jisx0213-text」スキルに従います。

## 3. 対応範囲

- 作るのは Web 版だけです。CLI やネイティブのバイナリーは作りません。GitHub Pages にも公開しません。配布は CI の成果物と Release の zip で行います。
- 対象は Sipeed Tang Nano 1K・4K・9K・20K です。ボードを増やすときは、upstream の対応、IDCODE、フラッシュの構成を公式の資料とソースで確かめてから計画します。
- 書き込み処理は upstream の openFPGALoader を Emscripten で WASM にして使い、自分で移植しません。
- 動作には Chromium 系ブラウザーの WebUSB と JSPI、配信時の COOP/COEP ヘッダーが必要です。pthread を外す構成は、upstream の libusb が共有メモリーと pthread を使うため動きません（RESEARCH.md）。
- Emscripten のオプションは安定性を最優先にし、そのうえで実行速度で選びます。変更するときは「experiment-record」スキルで比べてから決めます。

## 4. 実機と仮想デバイス

- 実機の Tang Nano では試していません。実機で確かめていないことは「本リポジトリでは試していない」と書き、確認済みのようには書きません。
- 仮想の FT2232・GOWIN TAP・NOR フラッシュ（`tests/sim/fake-webusb.mjs`）で測った時間は、実機の値として扱いません。
- 仮想デバイスを変えるときは「fake-usb」スキルに従い、upstream の手順に合わせ、失敗を検出できることを負の対照で確かめます。
- upstream の openFPGALoader は、失敗しても終了コード 0 を返す場合があります。画面はログの `FAIL` も見て判定します。この判定を緩めません。

## 5. 外部リポジトリ（vendor/）

- `vendor/` の外部コードは shallow submodule として管理し、ファイルを直接編集しません。`.gitmodules` の `shallow = true` を維持します。
- 依存を追加・更新するときは「vendor-update」スキルに従います。
- 上流への Issue・PR・push・コメントは、人間の承認を得てから行います。

## 6. エージェントスキル

- リポジトリ固有のスキルは `.agents/skills/<name>/` に置きます。vendor 内のスキルはコピーせず、`.agents/skills/<name>` からのシンボリックリンクにします。
- Claude Code は `.claude/skills/` しか読まないため、`.claude/skills/<name>` → `../../.agents/skills/<name>` のリンクも必ず作ります。スキルを追加・改名・削除したら、リンクも同じ PR で直します。CI の `agent-docs` ワークフローがリンクの解決を検査します。Windows で clone するときは、シンボリックリンクを有効にします（`git config core.symlinks true` と、開発者モードか管理者権限）。
- 個人用の設定はコミットしません（`CLAUDE.local.md`、`.claude/settings.local.json`、`AGENTS.override.md` は gitignore 済み）。

| スキル | 使う場面 |
|---|---|
| `yomiyasu` | 日本語文書の推敲（`vendor/yomiyasu` へのリンク） |
| `jisx0213-text` | 範囲外の文字の置き換え、引用と upstream ファイルの例外 |
| `vendor-update` | 依存関係の変更履歴、採否、ライセンス、回帰テストの確認 |
| `experiment-record` | 実験・測定・比較の計画、実行、再現できる記録 |
| `fake-usb` | 仮想の FT2232・GOWIN TAP・NOR フラッシュの拡張と、負の対照 |

## 7. yomiyasu（日本語推敲スキル）

`vendor/yomiyasu` にある、AI が生成した日本語を読みやすく整えるスキルです。意味と条件を保ったまま、不自然な比喩、曖昧な主述関係、不要な装飾を直します。

- 呼び出し方: `/yomiyasu`、`$yomiyasu:yomiyasu`（Codex 系）、`yomiyasu:yomiyasu`（Claude Code）。依頼の文に「yomiyasu で」と書いても呼べます。
- 検査ツールは Python の標準ライブラリだけで動き、外部へ通信しません。
  - `python3 .agents/skills/yomiyasu/scripts/yomiyasu_lint.py <file>`: AI の文章に多い表現の候補を出します。
  - `python3 .agents/skills/yomiyasu/scripts/yomiyasu_check.py run --source <原文> --final <最終稿>`: 推敲の前後を比べ、数値・否定・主述が変わっていないかを確かめます。記録は git 最上位の `.yomiyasu/` に残ります（gitignore 済み）。
- 自動フックの `yomiyasu_hook.py` は各開発者の個人設定でだけ有効にし、リポジトリにはコミットしません。

## 8. 作業の進め方

- 自明でない作業は、調査して深い計画を立ててから着手します。計画はリポジトリにコミットせず、チャットで共有します。
- 調査の結果は `RESEARCH.md` に、実験・測定・比較は「experiment-record」スキルに従って `docs/experiments/` に残します。結果を PR 本文だけに書きません。
- 文書の根拠に、VM や個人環境のパスを書きません。リポジトリ内のファイル、upstream のファイルと行番号、CI の成果物、公開 URL を示します。
- 画面を変えたら、4 ボードのスクリーンショットを撮って目で確かめ、PR 本文に確かめた範囲を書きます。
- 変更は小さく、主題ごとにまとめます。
- 検証は、push する commit と同じ状態で行います。手元だけの変更を含む状態での成功は、push した commit の確認になりません。

## 9. 確認コマンド

```sh
git submodule update --init --depth 1    # submodule の取得
npm ci                                   # Playwright などの取得
npx playwright install --with-deps chromium
scripts/build-wasm.sh                    # openFPGALoader を WASM にする（build/jspi-pthread/）
scripts/build-web.sh                     # 画面と WASM を dist/ にまとめる
tests/fixtures/build-fs.sh               # 4 ボード用の .fs を作る（build/fixtures/）
node --test tests/web/*.test.mjs         # 画面の部品の単体テスト
WASM_BUILD_ROOT=build node --test --test-concurrency=1 tests/sim/*.test.mjs  # 仮想 USB での検出・書き込み
npx playwright test                      # 画面の E2E（dist/ を作り直してから動く）
python3 dist/serve.py --port 8000        # COOP/COEP 付きでローカル配信
shellcheck scripts/*.sh tests/fixtures/*.sh tests/check-*/run.sh
python3 .github/scripts/check-jisx0213.py
python3 .github/scripts/check-links.py
python3 .agents/skills/yomiyasu/scripts/yomiyasu_lint.py <file>
git diff --check
```

ビルドには Autotools（autoconf、automake、libtool）が必要です。`scripts/build-wasm.sh` は、使えない Autotools を見つけると止まります。
