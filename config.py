# config.py
import os
import zoneinfo
from flask import Flask
from flask_login import LoginManager
from flask_bcrypt import Bcrypt
import firebase_admin
from firebase_admin import credentials, firestore
from dotenv import load_dotenv

# 日本標準時の設定
JST = zoneinfo.ZoneInfo("Asia/Tokyo")

# 環境変数をロード
load_dotenv()

def create_app():
    """Flaskアプリケーションのファクトリ関数"""
    app = Flask(__name__)
    app.config['SECRET_KEY'] = 'your_super_secret_key_change_this_in_production'
    
    # セッションの設定を追加（永続化）
    app.config['SESSION_COOKIE_SECURE'] = False  # 開発環境ではFalse（本番ではTrue）
    app.config['SESSION_COOKIE_HTTPONLY'] = True
    app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
    app.config['PERMANENT_SESSION_LIFETIME'] = 86400  # 24時間（秒単位）
    app.config['REMEMBER_COOKIE_DURATION'] = 86400  # 24時間
    
    return app

def init_firebase():
    """Firebase Admin SDKの初期化"""
    cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if not firebase_admin._apps:  # 二重初期化を防止
        cred = credentials.Certificate(cred_path)
        firebase_admin.initialize_app(cred)
    
    return firestore.client()

def init_login_manager(app):
    """Flask-Loginの初期化"""
    login_manager = LoginManager(app)
    login_manager.login_view = 'auth.login'
    login_manager.login_message = 'このページにアクセスするにはログインが必要です。'
    login_manager.login_message_category = 'info'
    
    # AJAXリクエスト時の認証エラーハンドリング
    @login_manager.unauthorized_handler
    def unauthorized():
        from flask import request, jsonify, redirect, url_for
        if request.is_json or request.headers.get('X-Requested-With') == 'XMLHttpRequest':
            return jsonify({'status': 'error', 'message': '認証が必要です'}), 401
        return redirect(url_for('auth.login'))
    
    return login_manager

def init_bcrypt(app):
    """Flask-Bcryptの初期化"""
    return Bcrypt(app)