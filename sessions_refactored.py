# sessions_refactored.py
"""
セッション管理機能モジュール (理想版)
Strategy/Stateパターンによる拡張可能な設計
"""
from abc import ABC, abstractmethod
from typing import Optional, Dict, List, Any
from datetime import datetime
from math import radians, sin, cos, sqrt, atan2
from flask import Blueprint, request, jsonify
from flask_login import login_required, current_user
from firebase_admin import firestore
from config import JST
from models import db
from ai_evaluation import analyze_focus_points_for_session

# Blueprintの作成
sessions_bp = Blueprint('sessions', __name__)


# ===== 抽象セッション基底クラス =====
class SessionBase(ABC):
    """セッションの抽象基底クラス"""
    
    def __init__(self, session_id: str, user_id: str):
        self._session_id = session_id
        self._user_id = user_id
        self._status = 'pending'
    
    @abstractmethod
    def start(self) -> None:
        """セッション開始"""
        pass
    
    @abstractmethod
    def end(self) -> None:
        """セッション終了"""
        pass
    
    @abstractmethod
    def validate(self) -> bool:
        """セッションの妥当性を検証"""
        pass
    
    def get_session_id(self) -> str:
        return self._session_id
    
    def get_user_id(self) -> str:
        return self._user_id
    
    def get_status(self) -> str:
        return self._status


# ===== ログ保存戦略インターフェース =====
class LogSaveStrategy(ABC):
    """ログ保存戦略の抽象インターフェース"""
    
    @abstractmethod
    def save_logs(self, session_id: str, logs: List[dict]) -> int:
        """ログを保存して保存件数を返す"""
        pass
    
    @abstractmethod
    def validate_logs(self, logs: List[dict]) -> bool:
        """ログの妥当性を検証"""
        pass
    
    @abstractmethod
    def get_batch_size(self) -> int:
        """バッチサイズを取得"""
        pass


# ===== GPS ログ保存戦略 =====
class GPSBulkSaveStrategy(LogSaveStrategy):
    """GPS ログのバッチ保存戦略"""
    
    def __init__(self, db_client: firestore.Client, batch_size: int = 100):
        self._db = db_client
        self._batch_size = batch_size
    
    def save_logs(self, session_id: str, logs: List[dict]) -> int:
        """GPS ログを一括保存"""
        print(f"=== GPS BULK SAVE REQUEST ===")
        print(f"Session ID: {session_id}")
        print(f"GPS logs count: {len(logs)}")
        
        if not logs:
            print("No GPS logs to save")
            return 0
        
        try:
            session_ref = self._db.collection('sessions').document(session_id)
            gps_collection = session_ref.collection('gps_logs')
            
            batch = self._db.batch()
            saved_count = 0
            skipped_zero_count = 0
            
            for log in logs:
                if not self._validate_gps_log_structure(log):
                    continue
                
                latitude = log.get('latitude')
                longitude = log.get('longitude')
                
                # 緯度経度が0,0の場合はスキップ（描画ワープ防止）
                if float(latitude) == 0.0 and float(longitude) == 0.0:
                    skipped_zero_count += 1
                    continue
                
                # タイムスタンプ処理
                ts_ms = log.get('timestamp')
                if ts_ms:
                    ts_dt = datetime.fromtimestamp(ts_ms / 1000.0, JST)
                else:
                    ts_dt = datetime.now(JST)
                
                # バッチに追加
                doc_ref = gps_collection.document()
                batch.set(doc_ref, {
                    'latitude': float(latitude),
                    'longitude': float(longitude),
                    'speed': float(log.get('speed', 0.0)),
                    'event': log.get('event', 'normal'),
                    'quality': log.get('quality', 'unknown'),
                    'timestamp': ts_dt,
                    'timestamp_ms': ts_ms
                })
                saved_count += 1
            
            if saved_count > 0:
                batch.commit()
                print(f"✅ Successfully saved {saved_count} GPS logs")
            
            print(f"=== GPS BULK SAVE COMPLETED: {saved_count} saved, {skipped_zero_count} skipped ===")
            return saved_count
            
        except Exception as e:
            print(f"❌ Error saving GPS logs: {str(e)}")
            raise
    
    def validate_logs(self, logs: List[dict]) -> bool:
        """GPS ログの妥当性を検証"""
        if not logs:
            return False
        return all(self._validate_gps_log_structure(log) for log in logs)
    
    def get_batch_size(self) -> int:
        return self._batch_size
    
    def _validate_gps_log_structure(self, log: dict) -> bool:
        """GPS ログの構造を検証"""
        required_fields = ['latitude', 'longitude']
        return all(field in log and log[field] is not None for field in required_fields)


# ===== G ログ保存戦略 =====
class GLogSaveStrategy(LogSaveStrategy):
    """G ログのバッチ保存戦略"""
    
    def __init__(self, db_client: firestore.Client, batch_size: int = 100):
        self._db = db_client
        self._batch_size = batch_size
        self._evaluation_threshold = 0.25  # 加速度評価の閾値
    
    def save_logs(self, session_id: str, logs: List[dict]) -> int:
        """G ログを一括保存"""
        print(f"=== G LOG BULK SAVE REQUEST ===")
        print(f"Session ID: {session_id}")
        print(f"G logs count: {len(logs)}")
        
        if not logs:
            print("No G logs to save")
            return 0
        
        try:
            session_ref = self._db.collection('sessions').document(session_id)
            g_collection = session_ref.collection('g_logs')
            
            batch = self._db.batch()
            saved_count = 0
            
            for log in logs:
                if not self._validate_g_log_structure(log):
                    continue
                
                # タイムスタンプ処理
                ts_ms = log.get('timestamp')
                if ts_ms:
                    ts_dt = datetime.fromtimestamp(ts_ms / 1000.0, JST)
                else:
                    ts_dt = datetime.now(JST)
                
                # イベント評価（運転タイプ判定）
                event = self._process_evaluation(log)
                
                # バッチに追加
                doc_ref = g_collection.document()
                batch.set(doc_ref, {
                    'g_x': float(log.get('g_x', 0.0)),
                    'g_y': float(log.get('g_y', 0.0)),
                    'g_z': float(log.get('g_z', 0.0)),
                    'speed': float(log.get('speed', 0.0)),
                    'event': event,
                    'quality': log.get('quality', 'unknown'),
                    'timestamp': ts_dt,
                    'timestamp_ms': ts_ms
                })
                saved_count += 1
            
            if saved_count > 0:
                batch.commit()
                print(f"✅ Successfully saved {saved_count} G logs")
            
            return saved_count
            
        except Exception as e:
            print(f"❌ Error saving G logs: {str(e)}")
            raise
    
    def validate_logs(self, logs: List[dict]) -> bool:
        """G ログの妥当性を検証"""
        if not logs:
            return False
        return all(self._validate_g_log_structure(log) for log in logs)
    
    def get_batch_size(self) -> int:
        return self._batch_size
    
    def _validate_g_log_structure(self, log: dict) -> bool:
        """G ログの構造を検証"""
        required_fields = ['g_x', 'g_y', 'g_z']
        return all(field in log for field in required_fields)
    
    def _process_evaluation(self, log: dict) -> str:
        """加速度データから運転評価を生成"""
        event = log.get('event', 'normal')
        
        g_x = abs(float(log.get('g_x', 0.0)))
        g_z = abs(float(log.get('g_z', 0.0)))
        
        # 急加速/急減速/急旋回の判定
        if g_z > self._evaluation_threshold:
            if event == 'normal':
                event = 'sudden_brake' if g_z < 0 else 'sudden_accel'
        
        if g_x > self._evaluation_threshold:
            if event == 'normal':
                event = 'sharp_turn'
        
        return event


# ===== セッション状態インターフェース =====
class SessionState(ABC):
    """セッション状態の抽象インターフェース"""
    
    @abstractmethod
    def handle_start(self, session: SessionBase) -> None:
        """開始処理"""
        pass
    
    @abstractmethod
    def handle_end(self, session: SessionBase) -> None:
        """終了処理"""
        pass
    
    @abstractmethod
    def is_valid_transition(self, next_state: str) -> bool:
        """状態遷移の妥当性をチェック"""
        pass
    
    @abstractmethod
    def get_state_name(self) -> str:
        """状態名を取得"""
        pass


# ===== Active 状態 =====
class ActiveState(SessionState):
    """アクティブセッション状態"""
    
    def handle_start(self, session: SessionBase) -> None:
        """開始処理（既にアクティブなので何もしない）"""
        print(f"Session {session.get_session_id()} is already active")
    
    def handle_end(self, session: SessionBase) -> None:
        """終了処理"""
        print(f"Ending active session {session.get_session_id()}")
    
    def is_valid_transition(self, next_state: str) -> bool:
        """completed への遷移のみ許可"""
        return next_state == 'completed'
    
    def get_state_name(self) -> str:
        return 'active'


# ===== Completed 状態 =====
class CompletedState(SessionState):
    """完了セッション状態"""
    
    def handle_start(self, session: SessionBase) -> None:
        """開始処理（完了済みなので不可）"""
        raise RuntimeError(f"Cannot start completed session {session.get_session_id()}")
    
    def handle_end(self, session: SessionBase) -> None:
        """終了処理（既に完了済み）"""
        print(f"Session {session.get_session_id()} already completed")
    
    def is_valid_transition(self, next_state: str) -> bool:
        """完了後の遷移は不可"""
        return False
    
    def get_state_name(self) -> str:
        return 'completed'


# ===== 距離計算ヘルパー =====
class DistanceCalculator:
    """ハバーサイン公式による距離計算"""
    
    EARTH_RADIUS_KM = 6371.0
    
    @staticmethod
    def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """2点間の距離を計算（km）"""
        dlat = radians(lat2 - lat1)
        dlon = radians(lon2 - lon1)
        a = sin(dlat / 2)**2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2)**2
        c = 2 * atan2(sqrt(a), sqrt(1 - a))
        return DistanceCalculator.EARTH_RADIUS_KM * c
    
    @staticmethod
    def calculate_distance_from_firestore(session_id: str, db_client: firestore.Client) -> float:
        """FirestoreからGPSログを取得して距離計算"""
        gps_ref = db_client.collection('sessions').document(session_id).collection('gps_logs')
        docs = gps_ref.order_by('timestamp').stream()
        
        coords = []
        for d in docs:
            data = d.to_dict()
            lat = data.get("latitude")
            lng = data.get("longitude")
            
            # 無効値排除
            if lat is None or lng is None:
                continue
            if abs(lat) < 0.0001 and abs(lng) < 0.0001:
                continue
            
            coords.append((lat, lng))
        
        if len(coords) < 2:
            return 0.0
        
        total_km = 0.0
        for i in range(1, len(coords)):
            total_km += DistanceCalculator.haversine(
                coords[i-1][0], coords[i-1][1],
                coords[i][0], coords[i][1]
            )
        
        return round(total_km, 3)


# ===== セッションマネージャー =====
class SessionManager:
    """セッション管理クラス"""
    
    def __init__(self, db_client: firestore.Client):
        self._db = db_client
        self._gps_strategy = GPSBulkSaveStrategy(db_client)
        self._g_strategy = GLogSaveStrategy(db_client)
    
    def create_session(self, user_id: str) -> Dict[str, Any]:
        """新規セッションを作成（トランザクション）"""
        @firestore.transactional
        def _create_session_if_not_exists(transaction):
            sessions_ref = self._db.collection('sessions')
            query = sessions_ref.where('user_id', '==', user_id).where('status', '==', 'active')
            existing_sessions = list(query.stream(transaction=transaction))
            
            if existing_sessions:
                existing_session_id = existing_sessions[0].id
                print(f"⚠️ Active session already exists: {existing_session_id}")
                return {
                    'status': 'warning',
                    'message': '既にアクティブなセッションがあります',
                    'session_id': existing_session_id
                }
            
            # 新規セッション作成
            new_session_ref = sessions_ref.document()
            transaction.set(new_session_ref, {
                'user_id': user_id,
                'start_time': firestore.SERVER_TIMESTAMP,
                'status': 'active',
                'reflection': '',
                'created_at': firestore.SERVER_TIMESTAMP
            })
            
            new_session_id = new_session_ref.id
            print(f"✅ New session created: {new_session_id}")
            return {'session_id': new_session_id, 'status': 'ok'}
        
        transaction = self._db.transaction()
        return _create_session_if_not_exists(transaction)
    
    def end_session(self, session_id: str, user_id: str, session_data: dict) -> Dict[str, Any]:
        """セッションを終了（トランザクション）"""
        @firestore.transactional
        def _end_session(transaction):
            session_ref = self._db.collection('sessions').document(session_id)
            session_doc = session_ref.get(transaction=transaction)
            
            if not session_doc.exists:
                return {'status': 'error', 'message': 'Session not found'}
            
            current_data = session_doc.to_dict()
            if current_data.get('user_id') != user_id:
                return {'status': 'error', 'message': 'Permission denied'}
            
            if current_data.get('status') != 'active':
                print(f"Session {session_id} already ended")
                return {'status': 'ok', 'already': True}
            
            # 距離計算
            distance_km = DistanceCalculator.calculate_distance_from_firestore(session_id, self._db)
            print(f"🚗 Calculated distance: {distance_km} km")
            
            # セッション更新
            transaction.update(session_ref, {
                'end_time': firestore.SERVER_TIMESTAMP,
                'status': 'completed',
                'distance': distance_km,
                'sudden_accels': int(session_data.get('sudden_accels', 0)),
                'sudden_brakes': int(session_data.get('sudden_brakes', 0)),
                'sharp_turns': int(session_data.get('sharp_turns', 0)),
                'stability': float(session_data.get('stability', 0.0)),
                'speed_violations': int(session_data.get('speed_violations', 0)),
                'focus_point': session_data.get('focus_point', '')
            })
            
            print(f"✅ Session {session_id} ended successfully")
            return {'status': 'ok', 'already': False}
        
        transaction = self._db.transaction()
        return _end_session(transaction)
    
    def get_gps_strategy(self) -> GPSBulkSaveStrategy:
        return self._gps_strategy
    
    def get_g_strategy(self) -> GLogSaveStrategy:
        return self._g_strategy


# ===== グローバルインスタンス =====
session_manager = SessionManager(db)


# ===== レガシー互換関数 (元のsessions.pyから呼び出し可能) =====
def haversine(lat1, lon1, lat2, lon2):
    """後方互換性用のハバーサイン関数"""
    return DistanceCalculator.haversine(lat1, lon1, lat2, lon2)


def calculate_distance_from_firestore(session_id):
    """後方互換性用の距離計算関数"""
    return DistanceCalculator.calculate_distance_from_firestore(session_id, db)


# ===== ルートハンドラー (リファクタリング版) =====
@sessions_bp.route('/start', methods=['POST'])
@login_required
def start():
    """セッション開始"""
    try:
        user_id = current_user.id
        print(f"=== Session start request from user: {user_id} ===")
        
        result = session_manager.create_session(user_id)
        return jsonify(result)
        
    except Exception as e:
        print(f"❌ Error starting session: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@sessions_bp.route('/check_active', methods=['GET'])
@login_required
def check_active():
    """既存のアクティブセッションをチェック"""
    try:
        user_id = current_user.id
        print(f"=== Check active session for user: {user_id} ===")
        
        sessions_ref = db.collection('sessions')
        query = sessions_ref.where('user_id', '==', user_id).where('status', '==', 'active')
        existing_sessions = list(query.stream())
        
        if existing_sessions:
            session_id = existing_sessions[0].id
            session_data = existing_sessions[0].to_dict()
            print(f"✅ Found active session: {session_id}")
            return jsonify({
                'has_active': True,
                'session_id': session_id,
                'route_id': session_data.get('route_id')
            })
        else:
            print(f"✅ No active session for user {user_id}")
            return jsonify({'has_active': False})
            
    except Exception as e:
        print(f"❌ Error checking active session: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@sessions_bp.route('/end', methods=['POST'])
@login_required
def end():
    """セッション終了"""
    data = request.get_json()
    session_id = data.get('session_id')
    
    if not session_id:
        return jsonify({'status': 'error', 'message': 'Missing session_id'}), 400
    
    try:
        result = session_manager.end_session(session_id, current_user.id, data)
        
        # AI フィードバック生成（失敗してもセッション完了は続行）
        try:
            analyze_focus_points_for_session(session_id, current_user.id)
        except Exception as e:
            print(f"⚠️ AI evaluation error: {str(e)}")
        
        # 総合運転スコア計算（失敗してもセッション完了は続行）
        try:
            from score import calculate_session_overall_score
            calculate_session_overall_score(session_id, current_user.id)
        except Exception as e:
            print(f"⚠️ Score calculation error: {str(e)}")
        
        return jsonify({
            'status': result.get('status', 'ok'),
            'session_id': session_id,
            'already': result.get('already', False)
        })
        
    except Exception as e:
        print(f"❌ Error ending session: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@sessions_bp.route('/log_gps_bulk', methods=['POST'])
@login_required
def log_gps_bulk():
    """GPS ログ一括保存"""
    data = request.get_json()
    session_id = data.get('session_id')
    gps_logs = data.get('gps_logs', [])
    
    if not session_id:
        return jsonify({'status': 'error', 'message': 'Missing session_id'}), 400
    
    # セッション検証
    session_ref = db.collection('sessions').document(session_id)
    session_doc = session_ref.get()
    if not session_doc.exists or session_doc.to_dict().get('user_id') != current_user.id:
        return jsonify({'status': 'error', 'message': 'Permission denied'}), 403
    
    try:
        saved_count = session_manager.get_gps_strategy().save_logs(session_id, gps_logs)
        return jsonify({'status': 'ok', 'saved_count': saved_count})
    except Exception as e:
        print(f"❌ Error saving GPS logs: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500


@sessions_bp.route('/log_g_only', methods=['POST'])
@login_required
def log_g_only():
    """G ログ一括保存"""
    data = request.get_json()
    session_id = data.get('session_id')
    g_logs = data.get('g_logs', [])
    
    if not session_id:
        return jsonify({'status': 'error', 'message': 'Missing session_id'}), 400
    
    # セッション検証
    session_ref = db.collection('sessions').document(session_id)
    session_doc = session_ref.get()
    if not session_doc.exists or session_doc.to_dict().get('user_id') != current_user.id:
        return jsonify({'status': 'error', 'message': 'Permission denied'}), 403
    
    try:
        saved_count = session_manager.get_g_strategy().save_logs(session_id, g_logs)
        return jsonify({'status': 'ok', 'saved_count': saved_count})
    except Exception as e:
        print(f"❌ Error saving G logs: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500
