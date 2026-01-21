# score.py
"""
スコア計算機能モジュール (理想版)
抽象基底クラス+Strategyパターンによる拡張可能な設計
"""
from abc import ABC, abstractmethod
from typing import Dict, Tuple, Optional, Any
import math
import statistics
from datetime import datetime
from google.cloud import firestore
from pytz import timezone
import os
import numpy as np

# ==========================================================
#  基本設定
# ==========================================================
JST = timezone("Asia/Tokyo")
db = firestore.Client()


# ===== 抽象スコア計算基底クラス =====
class ScoreCalculatorBase(ABC):
    """スコア計算の抽象基底クラス"""
    
    def __init__(self):
        self._weight_parameters: Dict[str, float] = {}
        self._score_range: Tuple[float, float] = (0.0, 100.0)
    
    @abstractmethod
    def calculate(self, data: Dict[str, Any]) -> float:
        """スコアを計算"""
        pass
    
    @abstractmethod
    def normalize_score(self, raw_score: float) -> float:
        """スコアを正規化"""
        pass
    
    @abstractmethod
    def get_weight_parameters(self) -> Dict[str, float]:
        """重みパラメータを取得"""
        pass
    
    def set_weight_parameter(self, key: str, value: float) -> None:
        """重みパラメータを設定"""
        self._weight_parameters[key] = value
    
    def get_score_range(self) -> Tuple[float, float]:
        """スコア範囲を取得"""
        return self._score_range
    
    def _clamp_score(self, score: float) -> float:
        """スコアを範囲内にクランプ"""
        min_score, max_score = self._score_range
        return max(min_score, min(max_score, score))
    
    def _validate_data(self, data: Dict[str, Any]) -> bool:
        """データの妥当性を検証"""
        return data is not None and len(data) > 0


# ===== スコア計算戦略インターフェース =====
class ScoringStrategy(ABC):
    """スコア計算戦略の抽象インターフェース"""
    
    @abstractmethod
    def calculate_raw_score(self, metrics: Dict[str, float]) -> float:
        """生スコアを計算"""
        pass
    
    @abstractmethod
    def apply_penalties(self, score: float, violations: Dict[str, int]) -> float:
        """違反に基づくペナルティを適用"""
        pass
    
    @abstractmethod
    def apply_bonuses(self, score: float, achievements: Dict[str, Any]) -> float:
        """実績に基づくボーナスを適用"""
        pass


# ===== ジャーク計算器 =====
class JerkCalculator(ScoreCalculatorBase):
    """ジャーク（加加速度）計算クラス"""
    
    MIN_DATA_POINTS = 2
    MIN_TIME_DELTA_MS = 0.001
    
    def __init__(self, threshold_g_per_s: float = 0.5):
        super().__init__()
        self._threshold_g_per_s = threshold_g_per_s
        self._weight_parameters = {
            'jerk_z_weight': 1.0,
            'jerk_x_weight': 1.0
        }
    
    def calculate(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        ジャークと安定性指標を計算
        
        Args:
            data: {
                'avg_g_logs': list of dicts,
                'sample_rate_hz': float
            }
        
        Returns:
            ジャーク統計情報
        """
        if not self._validate_data(data):
            raise ValueError("Invalid data for jerk calculation")
        
        avg_g_logs = data.get('avg_g_logs', [])
        sample_rate_hz = data.get('sample_rate_hz', 10.0)
        
        # Numpy配列化
        gz_vals = np.array([float(g.get("g_z", 0.0)) for g in avg_g_logs])
        gx_vals = np.array([float(g.get("g_x", 0.0)) for g in avg_g_logs])
        speeds = np.array([float(g.get("speed", 0.0)) for g in avg_g_logs])
        
        # データ点数が少ない場合の早期リターン
        if len(gz_vals) < self.MIN_DATA_POINTS:
            return self._get_empty_jerk_stats(len(gz_vals))
        
        # ジャーク計算
        dt = 1.0 / float(sample_rate_hz)
        jerk_z = self._calculate_jerk_from_acceleration(gz_vals, dt)
        jerk_x = self._calculate_jerk_from_acceleration(gx_vals, dt)
        
        # イベントカウント
        jerk_z_count = int(np.sum(np.abs(jerk_z) > self._threshold_g_per_s))
        jerk_x_count = int(np.sum(np.abs(jerk_x) > self._threshold_g_per_s))
        
        # 速度の標準偏差
        speed_std = float(np.std(speeds)) if len(speeds) > 1 else 0.0
        
        # 走行距離
        total_distance_km = avg_g_logs[-1].get("distance_km", 1.0)
        try:
            total_distance_km = float(total_distance_km)
        except Exception:
            total_distance_km = 1.0
        if total_distance_km < 0.1:
            total_distance_km = 0.1
        
        # 正規化指標
        total_events = jerk_z_count + jerk_x_count
        jerk_events_per_km = total_events / total_distance_km
        
        # 安定性スコア計算
        stability_ratio = self._calculate_stability_ratio(np.concatenate([jerk_z, jerk_x]))
        
        return {
            "jerk_z_count": jerk_z_count,
            "jerk_z_mean": float(np.mean(np.abs(jerk_z))),
            "jerk_z_max": float(np.max(np.abs(jerk_z))),
            "jerk_z_std": float(np.std(jerk_z)),
            "jerk_x_count": jerk_x_count,
            "jerk_x_mean": float(np.mean(np.abs(jerk_x))),
            "jerk_x_max": float(np.max(np.abs(jerk_x))),
            "jerk_x_std": float(np.std(jerk_x)),
            "total_jerk_events": total_events,
            "jerk_events_per_km": float(jerk_events_per_km),
            "stability_score": stability_ratio,
            "speed_std": float(speed_std),
            "total_distance_km": float(total_distance_km),
            "data_points": len(gz_vals),
        }
    
    def normalize_score(self, raw_score: float) -> float:
        """スコアを0-100に正規化"""
        return self._clamp_score(raw_score)
    
    def get_weight_parameters(self) -> Dict[str, float]:
        """重みパラメータを取得"""
        return self._weight_parameters
    
    def set_threshold(self, threshold: float) -> None:
        """閾値を設定"""
        self._threshold_g_per_s = threshold
    
    def _calculate_jerk_from_acceleration(self, acc_data: np.ndarray, dt: float) -> np.ndarray:
        """加速度データからジャークを計算"""
        if dt < self.MIN_TIME_DELTA_MS:
            raise ValueError(f"Time delta too small: {dt}")
        return np.diff(acc_data) / dt
    
    def _calculate_stability_ratio(self, jerk_data: np.ndarray) -> float:
        """安定性比率を計算（低ジャーク区間 / 全区間）"""
        if len(jerk_data) == 0:
            return 1.0
        stable_count = np.sum(np.abs(jerk_data) < self._threshold_g_per_s * 0.5)
        return float(stable_count / len(jerk_data))
    
    def _get_empty_jerk_stats(self, data_points: int) -> Dict[str, Any]:
        """空のジャーク統計を返す"""
        return {
            "jerk_z_count": 0,
            "jerk_z_mean": 0.0,
            "jerk_z_max": 0.0,
            "jerk_z_std": 0.0,
            "jerk_x_count": 0,
            "jerk_x_mean": 0.0,
            "jerk_x_max": 0.0,
            "jerk_x_std": 0.0,
            "total_jerk_events": 0,
            "jerk_events_per_km": 0.0,
            "stability_score": 1.0,
            "speed_std": 0.0,
            "total_distance_km": 0.1,
            "data_points": data_points,
        }


# ===== 総合スコア計算器 =====
class OverallScoreCalculator(ScoreCalculatorBase):
    """総合運転スコア計算クラス"""
    
    BASE_SCORE = 100.0
    MIN_SCORE = 0.0
    
    def __init__(self, weight_jerk_mean: float = 3.0, weight_jerk_max: float = 2.0, weight_stability: float = 1.0):
        super().__init__()
        self._weight_parameters = {
            'jerk_mean': weight_jerk_mean,
            'jerk_max': weight_jerk_max,
            'stability': weight_stability
        }
    
    def calculate(self, data: Dict[str, Any]) -> Tuple[int, str]:
        """
        総合スコアを計算
        
        Args:
            data: {'jerk_stats': dict}
        
        Returns:
            (score, comment) のタプル
        """
        if not self._validate_data(data):
            return 0, "データ不足"
        
        jerk_stats = data.get('jerk_stats', {})
        
        if not jerk_stats or jerk_stats.get("data_points", 0) == 0:
            return 0, "データ点数が少ないため参考値です。データ不足"
        
        # log1p を使用した減点の緩和
        jerk_per_km = float(jerk_stats["jerk_events_per_km"])
        speed_std = float(jerk_stats["speed_std"])
        
        # 減点計算
        penalty = self._calculate_penalty(jerk_stats)
        
        # ボーナス計算（安定性）
        bonus = self._calculate_bonus(jerk_stats.get("stability_score", 0.0))
        
        # 最終スコア
        final_score = self.BASE_SCORE - penalty + bonus
        final_score = self._clamp_score(final_score)
        
        # コメント生成
        comment = self._generate_comment(int(final_score))
        
        return int(final_score), comment
    
    def normalize_score(self, raw_score: float) -> float:
        """スコアを0-100に正規化"""
        return self._clamp_score(raw_score)
    
    def get_weight_parameters(self) -> Dict[str, float]:
        """重みパラメータを取得"""
        return self._weight_parameters
    
    def set_weights(self, mean: float, max_val: float, stability: float) -> None:
        """重みを設定"""
        self._weight_parameters['jerk_mean'] = mean
        self._weight_parameters['jerk_max'] = max_val
        self._weight_parameters['stability'] = stability
    
    def _calculate_penalty(self, jerk_stats: Dict[str, float]) -> float:
        """ペナルティを計算"""
        A = self._weight_parameters['jerk_mean']
        B = self._weight_parameters['jerk_max']
        
        jerk_per_km = float(jerk_stats["jerk_events_per_km"])
        speed_std = float(jerk_stats["speed_std"])
        
        # log1p で減点を緩和
        Jn = math.log1p(jerk_per_km)
        Sn = math.log1p(speed_std)
        
        return A * Jn + B * Sn
    
    def _calculate_bonus(self, stability_score: float) -> float:
        """ボーナスを計算"""
        stability_weight = self._weight_parameters['stability']
        # 安定性が高いほどボーナス（最大10点）
        return min(10.0, stability_score * stability_weight * 10)
    
    def _generate_comment(self, score: int) -> str:
        """スコアに基づくコメントを生成"""
        if score >= 90:
            return "非常に滑らかで、ほとんど完璧な運転でした。素晴らしい！"
        elif score >= 80:
            return "安定性が高く、安全運転の意識が感じられます。急操作は非常に少ないです。"
        elif score >= 70:
            return "おおむね良好な運転ですが、加減速またはハンドルの操作に若干の揺れが見られました。"
        elif score >= 50:
            return "改善余地あり。急操作を減らし、速度変化を滑らかにするとスコアが上がります。"
        else:
            return "急な操作が多く、速度のばらつきも大きい傾向です。特に加減速の滑らかさを意識しましょう。"


# ===== ジャーク・安定性スコア戦略 =====
class JerkStabilityScoringStrategy(ScoringStrategy):
    """ジャークと安定性に基づくスコア計算戦略"""
    
    def __init__(self, jerk_calculator: JerkCalculator):
        self._jerk_calculator = jerk_calculator
    
    def calculate_raw_score(self, metrics: Dict[str, float]) -> float:
        """生スコアを計算"""
        # ジャーク統計から基礎スコアを計算
        jerk_per_km = metrics.get('jerk_events_per_km', 0.0)
        speed_std = metrics.get('speed_std', 0.0)
        
        # 対数スケールで減点
        penalty = 3.0 * math.log1p(jerk_per_km) + 2.0 * math.log1p(speed_std)
        return 100.0 - penalty
    
    def apply_penalties(self, score: float, violations: Dict[str, int]) -> float:
        """違反に基づくペナルティを適用"""
        penalty = 0.0
        penalty += violations.get('sudden_accels', 0) * 2.0
        penalty += violations.get('sudden_brakes', 0) * 2.0
        penalty += violations.get('sharp_turns', 0) * 1.5
        penalty += violations.get('speed_violations', 0) * 3.0
        
        return max(0.0, score - penalty)
    
    def apply_bonuses(self, score: float, achievements: Dict[str, Any]) -> float:
        """実績に基づくボーナスを適用"""
        bonus = 0.0
        
        # 安定性ボーナス
        stability = achievements.get('stability_score', 0.0)
        bonus += stability * 10.0
        
        # 長距離運転ボーナス
        distance = achievements.get('total_distance_km', 0.0)
        if distance > 50.0:
            bonus += 5.0
        elif distance > 20.0:
            bonus += 2.0
        
        return min(100.0, score + bonus)


# ===== レガシー互換関数 =====
# 改良版スコアの重み（ユーザー指定：甘め設定）
WEIGHT_A = 3.0  # jerk（イベント密度）側の重み
WEIGHT_B = 2.0  # speed_std（速度ばらつき）側の重み


def calculate_jerk_and_stability(avg_g_logs: list, sample_rate_hz: float = 10.0) -> dict:
    """
    レガシー互換: ジャークと安定性指標の計算
    """
    calculator = JerkCalculator(threshold_g_per_s=0.5)
    return calculator.calculate({
        'avg_g_logs': avg_g_logs,
        'sample_rate_hz': sample_rate_hz
    })


def calculate_overall_driving_score(jerk_stats: dict, A=WEIGHT_A, B=WEIGHT_B) -> Tuple[int, str]:
    """
    レガシー互換: 総合スコア計算
    """
    calculator = OverallScoreCalculator(weight_jerk_mean=A, weight_jerk_max=B, weight_stability=1.0)
    return calculator.calculate({'jerk_stats': jerk_stats})


def calculate_session_overall_score(session_id: str, user_id: str, sample_rate_hz: float = 10.0) -> dict:
    """
    総合スコア解析（Firestore読み込み→計算→保存）
    """
    sess_ref = db.collection("sessions").document(session_id)
    
    # ログの読み込み
    avg_g_logs = [
        d.to_dict()
        for d in sess_ref.collection("avg_g_logs").order_by("timestamp").stream()
    ]
    
    if not avg_g_logs or len(avg_g_logs) < 5:
        print(f"⚠️ ログデータが非常に少ないです（{len(avg_g_logs)}点）。参考値としてスコアを計算します。")
        jerk_stats = calculate_jerk_and_stability(avg_g_logs, sample_rate_hz=sample_rate_hz)
        overall_score, score_comment = calculate_overall_driving_score(jerk_stats)
        score_comment = "データ点数が少ないため参考値です。" + score_comment
        score_data = {
            "overall_score": overall_score,
            "score_comment": score_comment,
            "calculated_at": datetime.now(JST),
            "jerk_stats": jerk_stats,
            "weights": {"A": WEIGHT_A, "B": WEIGHT_B},
            "scoring_mode": "improved_log1p",
        }
        sess_ref.update(score_data)
        return score_data
    
    # ジャーク＆安定性指標
    jerk_stats = calculate_jerk_and_stability(avg_g_logs, sample_rate_hz=sample_rate_hz)
    
    # スコア計算
    overall_score, score_comment = calculate_overall_driving_score(jerk_stats)
    
    # Firestoreに保存
    score_data = {
        "overall_score": overall_score,
        "score_comment": score_comment,
        "calculated_at": datetime.now(JST),
        "jerk_stats": jerk_stats,
        "weights": {"A": WEIGHT_A, "B": WEIGHT_B},
        "scoring_mode": "improved_log1p",
        "sample_rate_hz_used": float(sample_rate_hz),
    }
    
    sess_ref.update(score_data)
    print(f"✅ Session {session_id} の総合スコア: {overall_score}点（log1p改良版 / A={WEIGHT_A}, B={WEIGHT_B}）で更新")
    return score_data
