# auth.py
"""
認証機能モジュール (理想版)
Strategyパターンによる拡張可能な認証システム
"""
from abc import ABC, abstractmethod
from typing import Optional, Dict, Tuple
from datetime import datetime, timedelta
import re
from flask import Blueprint, render_template, request, redirect, url_for, flash, session
from flask_login import login_user, logout_user, login_required
from flask_bcrypt import Bcrypt
from firebase_admin import auth, firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from models import User, db

# Blueprintの作成
auth_bp = Blueprint('auth', __name__)

# グローバル変数
bcrypt_instance: Optional[Bcrypt] = None
auth_strategy: Optional['AuthenticationStrategy'] = None


# ===== 認証戦略インターフェース =====
class AuthenticationStrategy(ABC):
    """認証戦略の抽象インターフェース"""
    
    @abstractmethod
    def authenticate(self, username: str, password: str) -> Optional[User]:
        """認証処理を実行"""
        pass
    
    @abstractmethod
    def create_user(self, username: str, password: str, email: Optional[str] = None) -> User:
        """ユーザーを作成"""
        pass
    
    @abstractmethod
    def validate_credentials(self, credentials: Dict[str, str]) -> bool:
        """認証情報の妥当性を検証"""
        pass


# ===== Bcrypt認証戦略 =====
class BcryptAuthStrategy(AuthenticationStrategy):
    """Bcryptを使用した認証戦略"""
    
    def __init__(self, bcrypt: Bcrypt, db_client: firestore.Client):
        self._bcrypt = bcrypt
        self._db = db_client
    
    def authenticate(self, username: str, password: str) -> Optional[User]:
        """ユーザー名とパスワードで認証"""
        try:
            # ユーザー検索
            users_ref = self._db.collection('users')
            user_query = users_ref.where(filter=FieldFilter('username', '==', username)).limit(1).stream()
            user_doc = next(user_query, None)
            
            if not user_doc:
                return None
            
            user_data = user_doc.to_dict()
            user_uid = user_doc.id
            
            # パスワード検証
            if 'password_hash' in user_data:
                if self._verify_password(password, user_data['password_hash']):
                    return User(user_uid, username, user_data.get('email'))
            
            return None
            
        except Exception as e:
            print(f"❌ Authentication failed for {username}: {str(e)}")
            return None
    
    def create_user(self, username: str, password: str, email: Optional[str] = None) -> User:
        """新規ユーザーを作成"""
        # ユーザー名重複チェック
        users_ref = self._db.collection('users')
        existing_user_query = users_ref.where(filter=FieldFilter('username', '==', username)).limit(1).stream()
        existing_users = list(existing_user_query)
        
        if existing_users:
            raise ValueError("Username already exists")
        
        try:
            # Firebase Authentication でユーザー作成
            user_email = email or f"{username}@example.com"
            user_record = auth.create_user(
                email=user_email,
                password=password,
                display_name=username
            )
            user_uid = user_record.uid
            
            # Firestoreにユーザー情報保存
            hashed_password = self._hash_password(password)
            self._db.collection('users').document(user_uid).set({
                'username': username,
                'email': user_email,
                'created_at': firestore.SERVER_TIMESTAMP,
                'password_hash': hashed_password,
                'last_login': None
            })
            
            return User(user_uid, username, user_email)
            
        except Exception as e:
            print(f"❌ User creation failed for {username}: {str(e)}")
            raise
    
    def validate_credentials(self, credentials: Dict[str, str]) -> bool:
        """認証情報の基本検証"""
        required_fields = ['username', 'password']
        if not all(field in credentials for field in required_fields):
            return False
        
        username = credentials['username']
        password = credentials['password']
        
        # ユーザー名検証
        if not username or len(username) < 3 or len(username) > 50:
            return False
        
        # パスワード検証
        if not password or len(password) < 3:
            return False
        
        return True
    
    def _hash_password(self, password: str) -> str:
        """パスワードをハッシュ化"""
        return self._bcrypt.generate_password_hash(password).decode('utf-8')
    
    def _verify_password(self, password: str, password_hash: str) -> bool:
        """パスワードを検証"""
        return self._bcrypt.check_password_hash(password_hash, password)


# ===== 初期化関数 =====
def init_auth(bcrypt: Bcrypt):
    """認証モジュールの初期化（bcryptインスタンスを受け取る）"""
    global bcrypt_instance, auth_strategy
    bcrypt_instance = bcrypt
    auth_strategy = BcryptAuthStrategy(bcrypt, db)
    print("✅ Auth module initialized with BcryptAuthStrategy")


# ===== ルートハンドラー =====
@auth_bp.route('/register', methods=['GET', 'POST'])
def register():
    """ユーザー登録"""
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        
        # 認証情報検証
        if not auth_strategy.validate_credentials({'username': username, 'password': password}):
            flash('入力内容が不正です')
            return redirect(url_for('auth.register'))
        
        try:
            # ユーザー作成
            user = auth_strategy.create_user(username, password)
            flash('登録成功。ログインしてください')
            return redirect(url_for('auth.login'))
            
        except ValueError as e:
            flash(str(e))
            return redirect(url_for('auth.register'))
        except Exception as e:
            print(f"❌ Registration error: {str(e)}")
            flash('ユーザー登録に失敗しました。' + str(e))
            return redirect(url_for('auth.register'))
    
    return render_template('register.html')


@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    """ログイン"""
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']
        
        try:
            # 認証実行
            user = auth_strategy.authenticate(username, password)
            
            if user:
                # セッションを永続化（24時間有効）
                session.permanent = True
                login_user(user, remember=True)
                
                # 最終ログイン時刻を更新
                db.collection('users').document(user.id).update({
                    'last_login': firestore.SERVER_TIMESTAMP
                })
                
                print(f"✅ User {username} ({user.id}) logged in successfully")
                return redirect(url_for('views.index'))
            else:
                flash('ログインに失敗しました')
                return redirect(url_for('auth.login'))
        
        except Exception as e:
            print(f"❌ Login error: {str(e)}")
            flash('ログインに失敗しました。' + str(e))
            return redirect(url_for('auth.login'))
    
    return render_template('login.html')


@auth_bp.route('/logout')
@login_required
def logout():
    """ログアウト"""
    logout_user()
    flash('ログアウトしました')
    return redirect(url_for('auth.login'))