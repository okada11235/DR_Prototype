# auth.py
from flask import Blueprint, render_template, request, redirect, url_for, flash
from flask_login import login_user, logout_user, login_required
from firebase_admin import auth, firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from models import User, db

# Blueprintの作成
auth_bp = Blueprint('auth', __name__)

def init_auth(bcrypt):
    """認証モジュールの初期化（bcryptインスタンスを受け取る）"""
    global bcrypt_instance
    bcrypt_instance = bcrypt

# ユーザー登録
@auth_bp.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']

        users_ref = db.collection('users')
        existing_user_query = users_ref.where(filter=FieldFilter('username', '==', username)).limit(1).stream()
        existing_users = list(existing_user_query)

        if existing_users:
            flash('ユーザー名は既に使われています')
            return redirect(url_for('auth.register'))

        try:
            user_record = auth.create_user(
                email=f"{username}@example.com",
                password=password,
                display_name=username
            )
            user_uid = user_record.uid

            hashed_password = bcrypt_instance.generate_password_hash(password).decode('utf-8')

            db.collection('users').document(user_uid).set({
                'username': username,
                'email': f"{username}@example.com",
                'created_at': firestore.SERVER_TIMESTAMP,
                'password_hash': hashed_password
            })

            flash('登録成功。ログインしてください')
            return redirect(url_for('auth.login'))
        except Exception as e:
            print(f"Error creating user: {e}")
            flash('ユーザー登録に失敗しました。' + str(e))
            return redirect(url_for('auth.register'))

    return render_template('register.html')

# ログイン
@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form['username']
        password = request.form['password']

        try:
            users_ref = db.collection('users')
            user_query = users_ref.where(filter=FieldFilter('username', '==', username)).limit(1).stream()
            user_doc = next(user_query, None)

            if user_doc:
                user_data = user_doc.to_dict()
                user_uid = user_doc.id

                if 'password_hash' in user_data and bcrypt_instance.check_password_hash(user_data['password_hash'], password):
                    user = User(user_uid, username)
                    login_user(user)
                    return redirect(url_for('views.index'))
                else:
                    flash('ログインに失敗しました')
                    return redirect(url_for('auth.login'))
            else:
                flash('ログインに失敗しました')
                return redirect(url_for('auth.login'))

        except Exception as e:
            print(f"Error during login: {e}")
            flash('ログインに失敗しました。' + str(e))
            return redirect(url_for('auth.login'))

    return render_template('login.html')

# ログアウト
@auth_bp.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('auth.login'))