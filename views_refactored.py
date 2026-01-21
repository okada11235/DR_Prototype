# views_refactored.py
"""
ビュー・ルーティング機能モジュール (理想版)
抽象基底クラス+Strategyパターンによる拡張可能な設計
"""
from abc import ABC, abstractmethod
from typing import Dict, Optional, Any, List
from flask import Blueprint, render_template, request, jsonify, redirect, url_for, Response
from flask_login import login_required, current_user
from firebase_admin import firestore
from models import db

# Blueprintの作成
views_bp = Blueprint('views', __name__)


# ===== 抽象ビュー基底クラス =====
class ViewBase(ABC):
    """ビューの抽象基底クラス"""
    
    def __init__(self):
        self._template_cache: Dict[str, str] = {}
        self._context_cache: Dict[str, Any] = {}
    
    @abstractmethod
    def render(self, context: Dict[str, Any]) -> str:
        """ビューをレンダリング"""
        pass
    
    @abstractmethod
    def validate_request(self) -> bool:
        """リクエストの妥当性を検証"""
        pass
    
    @abstractmethod
    def prepare_context(self) -> Dict[str, Any]:
        """コンテキストを準備"""
        pass
    
    def clear_cache(self) -> None:
        """キャッシュをクリア"""
        self._template_cache.clear()
        self._context_cache.clear()
    
    def _get_default_context(self) -> Dict[str, Any]:
        """デフォルトコンテキストを取得"""
        return {
            'user': current_user if current_user.is_authenticated else None
        }


# ===== レスポンス戦略インターフェース =====
class ResponseStrategy(ABC):
    """レスポンス戦略の抽象インターフェース"""
    
    @abstractmethod
    def format_response(self, data: Dict[str, Any]) -> Response:
        """レスポンスをフォーマット"""
        pass
    
    @abstractmethod
    def get_content_type(self) -> str:
        """コンテンツタイプを取得"""
        pass
    
    @abstractmethod
    def get_status_code(self) -> int:
        """ステータスコードを取得"""
        pass
    
    @abstractmethod
    def set_headers(self, headers: Dict[str, str]) -> None:
        """ヘッダーを設定"""
        pass
    
    @abstractmethod
    def handle_error(self, error: Exception) -> Response:
        """エラーをハンドリング"""
        pass


# ===== JSON レスポンス戦略 =====
class JsonResponseStrategy(ResponseStrategy):
    """JSON レスポンス戦略"""
    
    def __init__(self):
        self._headers: Dict[str, str] = {'Content-Type': 'application/json'}
        self._status_code = 200
    
    def format_response(self, data: Dict[str, Any]) -> Response:
        """JSON レスポンスをフォーマット"""
        return jsonify(data), self._status_code, self._headers
    
    def get_content_type(self) -> str:
        return 'application/json'
    
    def get_status_code(self) -> int:
        return self._status_code
    
    def set_headers(self, headers: Dict[str, str]) -> None:
        self._headers.update(headers)
    
    def handle_error(self, error: Exception) -> Response:
        """エラーをJSON形式で返す"""
        return jsonify({
            'status': 'error',
            'message': str(error)
        }), 500, self._headers


# ===== HTML レスポンス戦略 =====
class HtmlResponseStrategy(ResponseStrategy):
    """HTML レスポンス戦略"""
    
    def __init__(self, template_name: str):
        self._template_name = template_name
        self._headers: Dict[str, str] = {'Content-Type': 'text/html'}
        self._status_code = 200
    
    def format_response(self, data: Dict[str, Any]) -> Response:
        """HTML レスポンスをフォーマット"""
        return render_template(self._template_name, **data)
    
    def get_content_type(self) -> str:
        return 'text/html'
    
    def get_status_code(self) -> int:
        return self._status_code
    
    def set_headers(self, headers: Dict[str, str]) -> None:
        self._headers.update(headers)
    
    def handle_error(self, error: Exception) -> Response:
        """エラーをHTML形式で返す"""
        return render_template('error.html', error=str(error)), 500


# ===== ビューコントローラー基底クラス =====
class ViewControllerBase(ABC):
    """ビューコントローラーの抽象基底クラス"""
    
    def __init__(self, template_name: str, response_strategy: Optional[ResponseStrategy] = None):
        self._template_name = template_name
        self._response_strategy = response_strategy or HtmlResponseStrategy(template_name)
        self._cache_enabled = False
        self._cache_timeout = 300  # 5分
    
    @abstractmethod
    def get(self, request: request) -> Response:
        """GETリクエストを処理"""
        pass
    
    @abstractmethod
    def post(self, request: request) -> Response:
        """POSTリクエストを処理"""
        pass
    
    def set_response_strategy(self, strategy: ResponseStrategy) -> None:
        """レスポンス戦略を設定"""
        self._response_strategy = strategy
    
    def get_template_name(self) -> str:
        """テンプレート名を取得"""
        return self._template_name
    
    def _validate_session_id(self, session_id: str) -> bool:
        """セッションIDの妥当性を検証"""
        if not session_id:
            return False
        
        try:
            session_ref = db.collection('sessions').document(session_id)
            session_doc = session_ref.get()
            return session_doc.exists
        except Exception as e:
            print(f"❌ Session validation error: {str(e)}")
            return False
    
    def _get_current_user(self):
        """現在のユーザーを取得"""
        return current_user if current_user.is_authenticated else None
    
    def _handle_error(self, error: Exception) -> Response:
        """エラーをハンドリング"""
        return self._response_strategy.handle_error(error)


# ===== セッションビューコントローラー =====
class SessionViewController(ViewControllerBase):
    """セッション関連のビューコントローラー"""
    
    def __init__(self):
        super().__init__('sessions.html')
    
    def get(self, request: request) -> Response:
        """セッション一覧を表示"""
        try:
            context = self._prepare_sessions_context()
            return self._response_strategy.format_response(context)
        except Exception as e:
            return self._handle_error(e)
    
    def post(self, request: request) -> Response:
        """セッション操作（削除など）を処理"""
        try:
            action = request.json.get('action')
            session_id = request.json.get('session_id')
            
            if action == 'delete':
                return self._delete_session(session_id)
            
            return jsonify({'status': 'error', 'message': 'Invalid action'}), 400
        except Exception as e:
            return self._handle_error(e)
    
    def _prepare_sessions_context(self) -> Dict[str, Any]:
        """セッション一覧のコンテキストを準備"""
        user = self._get_current_user()
        if not user:
            return {'sessions': []}
        
        sessions_ref = db.collection('sessions')
        query = sessions_ref.where('user_id', '==', user.id)\
            .order_by('created_at', direction=firestore.Query.DESCENDING)\
            .limit(50)
        
        sessions = []
        for doc in query.stream():
            session_data = doc.to_dict()
            session_data['id'] = doc.id
            sessions.append(session_data)
        
        return {'sessions': sessions, 'user': user}
    
    def _delete_session(self, session_id: str) -> Response:
        """セッションを削除"""
        if not self._validate_session_id(session_id):
            return jsonify({'status': 'error', 'message': 'Invalid session'}), 400
        
        user = self._get_current_user()
        session_ref = db.collection('sessions').document(session_id)
        session_doc = session_ref.get()
        
        if not session_doc.exists:
            return jsonify({'status': 'error', 'message': 'Session not found'}), 404
        
        session_data = session_doc.to_dict()
        if session_data.get('user_id') != user.id:
            return jsonify({'status': 'error', 'message': 'Permission denied'}), 403
        
        # サブコレクションも削除
        self._delete_subcollections(session_ref)
        session_ref.delete()
        
        return jsonify({'status': 'ok', 'message': 'Session deleted'})
    
    def _delete_subcollections(self, session_ref) -> None:
        """サブコレクションを削除"""
        subcollections = ['gps_logs', 'g_logs', 'avg_g_logs', 'focus_feedbacks']
        for subcol_name in subcollections:
            docs = session_ref.collection(subcol_name).stream()
            for doc in docs:
                doc.reference.delete()


# ===== ピンビューコントローラー =====
class PinViewController(ViewControllerBase):
    """ピン関連のビューコントローラー"""
    
    def __init__(self):
        super().__init__('pins.html', JsonResponseStrategy())
    
    def get(self, request: request) -> Response:
        """ピン一覧を取得"""
        try:
            session_id = request.args.get('session_id')
            route_id = request.args.get('route_id')
            
            if session_id:
                pins = self._get_pins_by_session(session_id)
            elif route_id:
                pins = self._get_pins_by_route(route_id)
            else:
                pins = self._get_all_pins()
            
            return jsonify({'status': 'ok', 'pins': pins})
        except Exception as e:
            return self._handle_error(e)
    
    def post(self, request: request) -> Response:
        """ピンを作成・更新"""
        try:
            data = request.json
            action = data.get('action', 'create')
            
            if action == 'create':
                return self._create_pin(data)
            elif action == 'update':
                return self._update_pin(data)
            elif action == 'delete':
                return self._delete_pin(data.get('pin_id'))
            
            return jsonify({'status': 'error', 'message': 'Invalid action'}), 400
        except Exception as e:
            return self._handle_error(e)
    
    def _get_pins_by_session(self, session_id: str) -> List[Dict]:
        """セッションに関連するピンを取得"""
        pins_ref = db.collection('priority_pins')
        query = pins_ref.where('session_id', '==', session_id)
        
        pins = []
        for doc in query.stream():
            pin_data = doc.to_dict()
            pin_data['id'] = doc.id
            pins.append(pin_data)
        
        return pins
    
    def _get_pins_by_route(self, route_id: str) -> List[Dict]:
        """ルートに関連するピンを取得"""
        pins_ref = db.collection('priority_pins')
        query = pins_ref.where('route_id', '==', route_id)
        
        pins = []
        for doc in query.stream():
            pin_data = doc.to_dict()
            pin_data['id'] = doc.id
            pins.append(pin_data)
        
        return pins
    
    def _get_all_pins(self) -> List[Dict]:
        """全ピンを取得"""
        user = self._get_current_user()
        if not user:
            return []
        
        pins_ref = db.collection('priority_pins')
        query = pins_ref.where('user_id', '==', user.id)\
            .order_by('created_at', direction=firestore.Query.DESCENDING)\
            .limit(100)
        
        pins = []
        for doc in query.stream():
            pin_data = doc.to_dict()
            pin_data['id'] = doc.id
            pins.append(pin_data)
        
        return pins
    
    def _create_pin(self, data: Dict) -> Response:
        """ピンを作成"""
        user = self._get_current_user()
        if not user:
            return jsonify({'status': 'error', 'message': 'Not authenticated'}), 401
        
        pin_ref = db.collection('priority_pins').document()
        pin_ref.set({
            'user_id': user.id,
            'route_id': data.get('route_id', ''),
            'lat': float(data.get('lat', 0)),
            'lng': float(data.get('lng', 0)),
            'label': data.get('label', ''),
            'focus_type': data.get('focus_type', ''),
            'focus_label': data.get('focus_label', ''),
            'priority_level': int(data.get('priority_level', 2)),
            'source_type': data.get('source_type', 'manual'),
            'created_at': firestore.SERVER_TIMESTAMP
        })
        
        return jsonify({'status': 'ok', 'pin_id': pin_ref.id})
    
    def _update_pin(self, data: Dict) -> Response:
        """ピンを更新"""
        pin_id = data.get('pin_id')
        if not pin_id:
            return jsonify({'status': 'error', 'message': 'Missing pin_id'}), 400
        
        user = self._get_current_user()
        pin_ref = db.collection('priority_pins').document(pin_id)
        pin_doc = pin_ref.get()
        
        if not pin_doc.exists:
            return jsonify({'status': 'error', 'message': 'Pin not found'}), 404
        
        pin_data = pin_doc.to_dict()
        if pin_data.get('user_id') != user.id:
            return jsonify({'status': 'error', 'message': 'Permission denied'}), 403
        
        update_data = {
            'label': data.get('label', pin_data.get('label')),
            'focus_type': data.get('focus_type', pin_data.get('focus_type')),
            'focus_label': data.get('focus_label', pin_data.get('focus_label')),
            'priority_level': int(data.get('priority_level', pin_data.get('priority_level', 2)))
        }
        
        pin_ref.update(update_data)
        return jsonify({'status': 'ok'})
    
    def _delete_pin(self, pin_id: str) -> Response:
        """ピンを削除"""
        if not pin_id:
            return jsonify({'status': 'error', 'message': 'Missing pin_id'}), 400
        
        user = self._get_current_user()
        pin_ref = db.collection('priority_pins').document(pin_id)
        pin_doc = pin_ref.get()
        
        if not pin_doc.exists:
            return jsonify({'status': 'error', 'message': 'Pin not found'}), 404
        
        pin_data = pin_doc.to_dict()
        if pin_data.get('user_id') != user.id:
            return jsonify({'status': 'error', 'message': 'Permission denied'}), 403
        
        pin_ref.delete()
        return jsonify({'status': 'ok'})


# ===== グローバルコントローラーインスタンス =====
session_controller = SessionViewController()
pin_controller = PinViewController()


# ===== レガシー互換ルート =====
@views_bp.route('/')
def index():
    """トップページ"""
    return redirect(url_for('views.home'))


@views_bp.route('/home')
@login_required
def home():
    """ホーム画面"""
    return render_template('home.html')


@views_bp.route('/explain')
def explain():
    """説明画面"""
    return render_template('explain.html')


@views_bp.route('/map_editor')
@login_required
def map_editor():
    """マップエディター画面"""
    return render_template('map_editor.html')


@views_bp.route('/recording_start')
@login_required
def recording_start():
    """記録開始画面"""
    return render_template('recording_start.html')


@views_bp.route('/recording_active')
@login_required
def recording_active():
    """記録中画面"""
    return render_template('recording_active.html')


@views_bp.route('/recording_completed')
@login_required
def recording_completed():
    """記録完了画面"""
    return render_template('recording_completed.html')


@views_bp.route('/sessions')
@login_required
def sessions_page():
    """セッション一覧画面"""
    return session_controller.get(request)


@views_bp.route('/sessions/<session_id>/delete', methods=['POST'])
@login_required
def delete_session(session_id):
    """セッション削除"""
    return session_controller._delete_session(session_id)


# ===== API エンドポイント =====
@views_bp.route('/api/pins', methods=['GET'])
@login_required
def get_pins():
    """ピン一覧取得API"""
    return pin_controller.get(request)


@views_bp.route('/api/pins', methods=['POST'])
@login_required
def save_pin():
    """ピン保存API"""
    return pin_controller.post(request)


@views_bp.route('/api/pins/<pin_id>', methods=['PUT'])
@login_required
def update_pin(pin_id):
    """ピン更新API"""
    data = request.json
    data['pin_id'] = pin_id
    data['action'] = 'update'
    return pin_controller.post(request)


@views_bp.route('/api/pins/<pin_id>', methods=['DELETE'])
@login_required
def delete_pin(pin_id):
    """ピン削除API"""
    return pin_controller._delete_pin(pin_id)
