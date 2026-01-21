# models.py
"""
ユーザーモデルモジュール (理想版)
抽象基底クラスによる拡張可能な設計
"""
from abc import ABC, abstractmethod
from typing import Optional, Dict
from datetime import datetime
from flask_login import UserMixin
from config import init_firebase

# Firestoreクライアントの取得
db = init_firebase()


# ===== 抽象ユーザー基底クラス =====
class UserBase(ABC):
    """ユーザーの抽象基底クラス"""
    
    def __init__(self, _id: str, username: str, email: Optional[str] = None):
        self._id = _id
        self._username = username
        self._email = email
        self._created_at = datetime.now()
    
    @abstractmethod
    def authenticate(self, credentials: Dict[str, str]) -> bool:
        """認証処理"""
        pass
    
    @abstractmethod
    def get_id(self) -> str:
        """ユーザーIDを取得"""
        pass
    
    @abstractmethod
    def is_authenticated(self) -> bool:
        """認証済みかチェック"""
        pass
    
    def get_username(self) -> str:
        """ユーザー名を取得"""
        return self._username
    
    def get_email(self) -> Optional[str]:
        """メールアドレスを取得"""
        return self._email
    
    def _validate_credentials(self, credentials: Dict[str, str]) -> bool:
        """認証情報の妥当性を検証"""
        required_fields = ['username', 'password']
        return all(field in credentials for field in required_fields)


# ===== 具象ユーザークラス =====
class User(UserMixin, UserBase):
    """ユーザーモデル (Flask-Login互換)"""
    
    def __init__(self, uid: str, username: str, email: Optional[str] = None):
        UserBase.__init__(self, uid, username, email)
        self.id = uid
        self.username = username
        self.email = email
    
    def authenticate(self, credentials: Dict[str, str]) -> bool:
        """認証処理 (継承先で実装)"""
        if not self._validate_credentials(credentials):
            return False
        # 実際の認証はAuthStrategyで処理
        return True
    
    def get_id(self) -> str:
        """Flask-Login用ID取得"""
        return str(self.id)
    
    def is_authenticated(self) -> bool:
        """Flask-Login用認証チェック"""
        return True  # UserMixinのデフォルト動作
    
    @staticmethod
    def get(user_id: str) -> Optional['User']:
        """ユーザーIDからユーザーを取得"""
        try:
            user_doc = db.collection('users').document(user_id).get()
            if user_doc.exists:
                user_data = user_doc.to_dict()
                return User(
                    uid=user_doc.id,
                    username=user_data.get('username', ''),
                    email=user_data.get('email')
                )
            return None
        except Exception as e:
            print(f"❌ Failed to get user {user_id}: {str(e)}")
            return None
    
    @staticmethod
    def find_by_username(username: str) -> Optional['User']:
        """ユーザー名からユーザーを取得"""
        try:
            users = db.collection('users').where('username', '==', username).limit(1).get()
            if users:
                user_doc = users[0]
                user_data = user_doc.to_dict()
                return User(
                    uid=user_doc.id,
                    username=user_data.get('username', ''),
                    email=user_data.get('email')
                )
            return None
        except Exception as e:
            print(f"❌ Failed to find user by username {username}: {str(e)}")
            return None
    
    def to_dict(self) -> Dict[str, any]:
        """辞書形式に変換"""
        return {
            'id': self.id,
            'username': self.username,
            'email': self.email,
            'created_at': self._created_at
        }