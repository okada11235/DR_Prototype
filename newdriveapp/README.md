# 運転記録アプリ (Flask)

## 概要
スマホ対応の運転記録アプリです。  
ユーザー登録・ログイン機能があり、  
加速度・GPSデータを使って走行記録を計測・保存・削除できます。

## 使い方

1. 仮想環境を作成し、依存関係をインストール
```bash
python -m venv venv
source venv/bin/activate  # Windowsの場合は venv\\Scripts\\activate
pip install -r requirements.txt
