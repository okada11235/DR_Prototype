# models.py
from flask_login import UserMixin
from config import init_firebase

# Firestoreクライアントの取得
db = init_firebase()

class User(UserMixin):
    """ユーザーモデル"""
    def __init__(self, uid, username):
        self.id = uid
        self.username = username

    @staticmethod
    def get(user_id):
        """ユーザーIDからユーザーを取得"""
        user_doc = db.collection('users').document(user_id).get()
        if user_doc.exists:
            user_data = user_doc.to_dict()
            return User(user_doc.id, user_data['username'])
        return None