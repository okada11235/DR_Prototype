# DriveBuddy - AI開発者向けガイド

## プロジェクト概要
スマートフォン向け運転記録アプリ。加速度センサーとGPSを使って運転データを計測し、リアルタイムで音声フィードバックを提供。

## アーキテクチャ

### バックエンド（Flask + Firebase）
- **エントリーポイント**: `app.py` - Blueprintベースのモジュラー設計
- **データストア**: Firebase Firestore（SQLiteローカル認証は `drive_data_auth.db`）
- **主要Blueprints**:
  - `auth.py` - ユーザー認証（Firebase Auth + bcrypt）
  - `sessions.py` - 運転セッション管理とデータ保存API
  - `views.py` - HTML画面レンダリング

### フロントエンド（Vanilla JS + ES6 Modules）
- **メインエントリー**: `static/main.js`
- **モジュール構成**:
  - `sensors.js` - DeviceMotion API による4分類運転評価（旋回・加速・減速・直進）+ GPS速度変化指摘機能
  - `session.js` - セッション状態管理とバッチデータ送信
  - `maps.js` - Google Maps統合とGPS位置取得
  - `audio.js` - リアルタイム音声フィードバック

## 重要な開発パターン

### データフロー
```
DeviceMotion → sensors.js → バッファ蓄積 → 一括送信 (/log_gps_bulk, /log_g_only)
```

### セッション管理
- トランザクション保護での重複セッション防止
- `localStorage` による画面間状態保持
- バックグラウンド定期保存（5秒間隔）

### 加速度センサー処理
- **自動キャリブレーション**: 端末方向検出 (`detectOrientation`)
- **4分類判定**: 継続時間ベースの運転評価
- **座標変換**: `adjustOrientation` で端末向きに依存しない計測

## 開発時の重要事項

### 環境設定
```bash
# 必須環境変数
GOOGLE_APPLICATION_CREDENTIALS=path/to/firebase-credentials.json

# 仮想環境セットアップ
python -m venv venv
venv\Scripts\activate  # Windows
pip install -r requirements.txt
```

### Firebase設定
- `config.py` の `init_firebase()` で認証情報読み込み
- フロントエンドは `templates/index.html` の `firebaseConfig` を使用
- Firestore構造: `sessions/{id}/gps_logs`, `sessions/{id}/g_logs`

### モバイル対応
- **iOS許可**: `sensors.js` の `DeviceMotionEvent.requestPermission()`
- **画面方向**: Tailwind CSS レスポンシブデザイン
- **PWA対応**: `manifest.json` 相当の設定は未実装

### データバッチ処理
- GPS/Gデータは5秒毎に一括送信
- Firestore batch write でトランザクション保護
- `timestamp_ms` と `timestamp` の両方保存（互換性）

## デバッグ・トラブルシューティング

### よくある問題
1. **センサー不動作**: ブラウザのHTTPS必須、iOSの許可確認
2. **セッション重複**: `sessions.py` のトランザクション処理確認
3. **GPS取得失敗**: `navigator.geolocation` のエラーハンドリング

### デバッグエンドポイント
- `/debug_session/<session_id>` - セッションデータ詳細確認
- `/test_gps_save/<session_id>` - GPSデータ保存テスト

### ログ出力パターン
```python
print(f"=== GPS BULK SAVE REQUEST ===")  # sessions.py
console.log('📱 Motion detection started.');  # sensors.js
```

## コーディング規約

### ファイル命名
- Python: スネークケース（`session_id`, `log_gps_bulk`）
- JavaScript: キャメルケース（`startSession`, `deviceMotion`）

### エラーハンドリング
- Flask: JSONレスポンス `{'status': 'error', 'message': str(e)}`
- JavaScript: console.error + ユーザー向けアラート

### 新機能追加時のチェックポイント
1. Firestore セキュリティルール更新
2. モバイルブラウザでの動作確認
3. バッテリー消費への影響評価
4. 音声フィードバックの適切性