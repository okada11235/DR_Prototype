# config.py
"""
設定・初期化機能モジュール (理想版)
Strategy/Factoryパターンを使用した拡張可能な初期化システム
"""
import os
import zoneinfo
import threading
from abc import ABC, abstractmethod
from typing import Dict, Optional, Any, Type
from flask import Flask, request, jsonify, redirect, url_for
from flask_login import LoginManager
from flask_bcrypt import Bcrypt
import firebase_admin
from firebase_admin import credentials, firestore
from dotenv import load_dotenv

# 日本標準時の設定
JST = zoneinfo.ZoneInfo("Asia/Tokyo")

# 環境変数をロード
load_dotenv()


# ===== 抽象基底クラス =====
class ConfigBase(ABC):
    """設定管理の基底クラス"""
    
    def __init__(self):
        self._config_cache: Dict[str, Any] = {}
        self._is_initialized: bool = False
    
    @abstractmethod
    def load_environment_variables(self) -> Dict[str, str]:
        """環境変数をロード"""
        pass
    
    @abstractmethod
    def validate_config(self) -> bool:
        """設定の妥当性を検証"""
        pass
    
    def get_config(self, key: str, default: Optional[Any] = None) -> Any:
        """キャッシュから設定値を取得"""
        return self._config_cache.get(key, default)
    
    def _cache_config(self, key: str, value: Any) -> None:
        """設定値をキャッシュ"""
        self._config_cache[key] = value


# ===== 初期化戦略インターフェース =====
class InitializerStrategy(ABC):
    """初期化戦略の抽象インターフェース"""
    
    @abstractmethod
    def initialize(self, app: Flask) -> None:
        """初期化処理を実行"""
        pass
    
    @abstractmethod
    def validate(self) -> bool:
        """初期化が正常に完了したか検証"""
        pass
    
    @abstractmethod
    def get_status(self) -> Dict[str, Any]:
        """初期化ステータスを取得"""
        pass
    
    @abstractmethod
    def rollback(self) -> None:
        """初期化をロールバック"""
        pass
    
    @abstractmethod
    def is_initialized(self) -> bool:
        """初期化済みかチェック"""
        pass


# ===== Firebase初期化戦略 =====
class FirebaseInitializer(InitializerStrategy):
    """Firebase Admin SDK初期化戦略"""
    
    CREDENTIAL_ENV_VAR = "GOOGLE_APPLICATION_CREDENTIALS"
    
    def __init__(self):
        self._credential_path: Optional[str] = None
        self._db_client: Optional[firestore.Client] = None
        self._is_initialized: bool = False
    
    def initialize(self, app: Flask) -> None:
        """Firebaseを初期化"""
        try:
            self._credential_path = os.getenv(self.CREDENTIAL_ENV_VAR)
            if not self._credential_path:
                raise ValueError(f"{self.CREDENTIAL_ENV_VAR} environment variable not set")
            
            if not firebase_admin._apps:  # 二重初期化を防止
                cred = self._load_credentials()
                firebase_admin.initialize_app(cred)
            
            self._db_client = firestore.client()
            
            if self._verify_connection():
                self._is_initialized = True
            else:
                raise ConnectionError("Failed to verify Firestore connection")
                
        except Exception as e:
            print(f"❌ Firebase initialization failed: {str(e)}")
            self.rollback()
            raise
    
    def validate(self) -> bool:
        """初期化の妥当性を検証"""
        return (
            self._is_initialized and 
            self._db_client is not None and
            self._credential_path is not None
        )
    
    def get_status(self) -> Dict[str, Any]:
        """ステータス情報を取得"""
        return {
            'initialized': self._is_initialized,
            'credential_path': self._credential_path,
            'has_client': self._db_client is not None
        }
    
    def rollback(self) -> None:
        """初期化をロールバック"""
        self._is_initialized = False
        self._db_client = None
        if firebase_admin._apps:
            firebase_admin.delete_app(firebase_admin.get_app())
    
    def is_initialized(self) -> bool:
        return self._is_initialized
    
    def get_client(self) -> firestore.Client:
        """Firestoreクライアントを取得"""
        if not self._is_initialized or not self._db_client:
            raise RuntimeError("Firebase not initialized. Call initialize() first.")
        return self._db_client
    
    def _load_credentials(self) -> credentials.Certificate:
        """認証情報をロード"""
        return credentials.Certificate(self._credential_path)
    
    def _verify_connection(self) -> bool:
        """接続を検証"""
        try:
            # ダミークエリで接続確認
            self._db_client.collection('_health_check').limit(1).get()
            return True
        except Exception as e:
            print(f"⚠️ Firestore connection verification failed: {str(e)}")
            return False


# ===== 認証初期化戦略 =====
class AuthInitializer(InitializerStrategy):
    """認証システム初期化戦略"""
    
    DEFAULT_LOGIN_VIEW = "auth.login"
    SESSION_LIFETIME_HOURS = 24
    
    def __init__(self):
        self._login_manager: Optional[LoginManager] = None
        self._bcrypt: Optional[Bcrypt] = None
        self._is_initialized: bool = False
    
    def initialize(self, app: Flask) -> None:
        """認証システムを初期化"""
        try:
            # Flask-Login初期化
            self._login_manager = LoginManager(app)
            self._login_manager.login_view = self.DEFAULT_LOGIN_VIEW
            self._login_manager.login_message = 'このページにアクセスするにはログインが必要です。'
            self._login_manager.login_message_category = 'info'
            
            # 未認証ハンドラー
            @self._login_manager.unauthorized_handler
            def unauthorized():
                if request.is_json or request.headers.get('X-Requested-With') == 'XMLHttpRequest':
                    return jsonify({'status': 'error', 'message': '認証が必要です'}), 401
                return redirect(url_for('auth.login'))
            
            # Flask-Bcrypt初期化
            self._bcrypt = Bcrypt(app)
            
            # セッション設定
            self._configure_session(app)
            
            if self._validate_session_config(app):
                self._is_initialized = True
            else:
                raise ValueError("Session configuration validation failed")
                
        except Exception as e:
            print(f"❌ Auth initialization failed: {str(e)}")
            self.rollback()
            raise
    
    def validate(self) -> bool:
        """初期化の妥当性を検証"""
        return (
            self._is_initialized and
            self._login_manager is not None and
            self._bcrypt is not None
        )
    
    def get_status(self) -> Dict[str, Any]:
        """ステータス情報を取得"""
        return {
            'initialized': self._is_initialized,
            'has_login_manager': self._login_manager is not None,
            'has_bcrypt': self._bcrypt is not None
        }
    
    def rollback(self) -> None:
        """初期化をロールバック"""
        self._is_initialized = False
        self._login_manager = None
        self._bcrypt = None
    
    def is_initialized(self) -> bool:
        return self._is_initialized
    
    def get_login_manager(self) -> LoginManager:
        """LoginManagerを取得"""
        if not self._is_initialized or not self._login_manager:
            raise RuntimeError("Auth not initialized. Call initialize() first.")
        return self._login_manager
    
    def get_bcrypt(self) -> Bcrypt:
        """Bcryptを取得"""
        if not self._is_initialized or not self._bcrypt:
            raise RuntimeError("Auth not initialized. Call initialize() first.")
        return self._bcrypt
    
    def _configure_session(self, app: Flask) -> None:
        """セッション設定を構成"""
        app.config['SESSION_COOKIE_SECURE'] = False  # 開発環境ではFalse
        app.config['SESSION_COOKIE_HTTPONLY'] = True
        app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
        app.config['PERMANENT_SESSION_LIFETIME'] = self.SESSION_LIFETIME_HOURS * 3600
        app.config['REMEMBER_COOKIE_DURATION'] = self.SESSION_LIFETIME_HOURS * 3600
    
    def _validate_session_config(self, app: Flask) -> bool:
        """セッション設定を検証"""
        required_keys = [
            'SESSION_COOKIE_HTTPONLY',
            'SESSION_COOKIE_SAMESITE',
            'PERMANENT_SESSION_LIFETIME'
        ]
        return all(key in app.config for key in required_keys)


# ===== 初期化ファクトリー (Singleton) =====
class InitializerFactory:
    """初期化戦略のファクトリー (Singletonパターン)"""
    
    _instance: Optional['InitializerFactory'] = None
    _lock = threading.Lock()
    _initializers: Dict[str, Type[InitializerStrategy]] = {
        'firebase': FirebaseInitializer,
        'auth': AuthInitializer
    }
    
    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
        return cls._instance
    
    @classmethod
    def get_instance(cls) -> 'InitializerFactory':
        """ファクトリーインスタンスを取得"""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance
    
    def create_initializer(self, initializer_type: str) -> InitializerStrategy:
        """初期化戦略を生成"""
        if initializer_type not in self._initializers:
            raise ValueError(f"Unknown initializer type: {initializer_type}")
        return self._initializers[initializer_type]()
    
    @classmethod
    def register_initializer(cls, name: str, initializer_class: Type[InitializerStrategy]) -> None:
        """新しい初期化戦略を登録"""
        cls._initializers[name] = initializer_class


# ===== レガシー互換関数 (後方互換性維持) =====
_firebase_initializer: Optional[FirebaseInitializer] = None
_auth_initializer: Optional[AuthInitializer] = None


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
    """Firebase Admin SDKの初期化 (レガシー互換)"""
    global _firebase_initializer
    
    if _firebase_initializer is None or not _firebase_initializer.is_initialized():
        factory = InitializerFactory.get_instance()
        _firebase_initializer = factory.create_initializer('firebase')
        _firebase_initializer.initialize(None)  # app不要
    
    return _firebase_initializer.get_client()


def init_login_manager(app):
    """Flask-Loginの初期化 (レガシー互換)"""
    global _auth_initializer
    
    if _auth_initializer is None or not _auth_initializer.is_initialized():
        factory = InitializerFactory.get_instance()
        _auth_initializer = factory.create_initializer('auth')
        _auth_initializer.initialize(app)
    
    return _auth_initializer.get_login_manager()


def init_bcrypt(app):
    """Flask-Bcryptの初期化 (レガシー互換)"""
    global _auth_initializer
    
    if _auth_initializer is None or not _auth_initializer.is_initialized():
        factory = InitializerFactory.get_instance()
        _auth_initializer = factory.create_initializer('auth')
        _auth_initializer.initialize(app)
    
    return _auth_initializer.get_bcrypt()