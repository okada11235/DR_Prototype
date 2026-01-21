# ai_evaluation_refactored.py
"""
AI評価・フィードバック機能モジュール (理想版)
Strategy/Factoryパターンによる拡張可能な設計
"""
from abc import ABC, abstractmethod
from typing import Dict, List, Tuple, Optional, Any
import math
import statistics
from datetime import datetime
from google.cloud import firestore
from pytz import timezone
import os
import google.generativeai as genai
import numpy as np

JST = timezone("Asia/Tokyo")
db = firestore.Client()


# ===== 抽象評価基底クラス =====
class EvaluatorBase(ABC):
    """評価器の抽象基底クラス"""
    
    @abstractmethod
    def evaluate(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """評価を実行"""
        pass
    
    @abstractmethod
    def calculate_score(self, stats: Dict[str, float]) -> float:
        """スコアを計算"""
        pass
    
    @abstractmethod
    def validate_data(self, data: Dict[str, Any]) -> bool:
        """データの妥当性を検証"""
        pass


# ===== AI生成戦略インターフェース =====
class AIGenerationStrategy(ABC):
    """AI生成戦略の抽象インターフェース"""
    
    @abstractmethod
    def generate_comment(self, stats: Dict[str, float], context: Dict[str, Any]) -> str:
        """コメントを生成"""
        pass
    
    @abstractmethod
    def summarize(self, text: str, max_length: int = 150) -> str:
        """テキストを要約"""
        pass
    
    @abstractmethod
    def get_model_name(self) -> str:
        """モデル名を取得"""
        pass


# ===== 統計計算インターフェース =====
class StatisticsCalculator(ABC):
    """統計計算の抽象インターフェース"""
    
    @abstractmethod
    def calculate(self, data: List[Dict[str, float]]) -> Dict[str, float]:
        """統計を計算"""
        pass
    
    @abstractmethod
    def validate_sample_size(self, data: List[Any]) -> bool:
        """サンプルサイズの妥当性を検証"""
        pass
    
    @abstractmethod
    def get_confidence_level(self) -> float:
        """信頼水準を取得"""
        pass


# ===== 詳細統計計算器 =====
class DetailedStatisticsCalculator(StatisticsCalculator):
    """詳細統計計算クラス"""
    
    MIN_SAMPLE_SIZE = 2
    CONFIDENCE_LEVEL = 0.95
    THRESHOLD_ACCELERATION = 0.25  # 急加速/減速の閾値
    
    def calculate(self, data: List[Dict[str, float]]) -> Dict[str, float]:
        """詳細な統計データを計算"""
        if not self.validate_sample_size(data):
            return self._get_empty_stats()
        
        gx_vals = [d.get('g_x', 0.0) for d in data]
        gz_vals = [d.get('g_z', 0.0) for d in data]
        speeds = [d.get('speed', 0.0) for d in data]
        
        stats = {
            "avg_speed": sum(speeds) / len(speeds) if speeds else 0,
            "mean_gx": sum(gx_vals) / len(gx_vals) if gx_vals else 0,
            "mean_gz": sum(gz_vals) / len(gz_vals) if gz_vals else 0,
            "std_gx": statistics.pstdev(gx_vals) if len(gx_vals) > 1 else 0,
            "std_gz": statistics.pstdev(gz_vals) if len(gz_vals) > 1 else 0,
            "max_gx": max(gx_vals, default=0),
            "max_gz": max(gz_vals, default=0),
            "min_gx": min(gx_vals, default=0),
            "min_gz": min(gz_vals, default=0),
            "median_gx": statistics.median(gx_vals) if gx_vals else 0,
            "median_gz": statistics.median(gz_vals) if gz_vals else 0,
            "std_speed": statistics.pstdev(speeds) if len(speeds) > 1 else 0,
            "max_speed": max(speeds, default=0),
            "min_speed": min(speeds, default=0),
            "median_speed": statistics.median(speeds) if speeds else 0,
            "speed_range": (max(speeds, default=0) - min(speeds, default=0)),
            "data_points": len(gx_vals)
        }
        
        # イベントカウント
        stats["acceleration_count"] = sum(1 for gz in gz_vals if gz > self.THRESHOLD_ACCELERATION)
        stats["deceleration_count"] = sum(1 for gz in gz_vals if gz < -self.THRESHOLD_ACCELERATION)
        stats["sharp_turn_count"] = sum(1 for gx in gx_vals if abs(gx) > self.THRESHOLD_ACCELERATION)
        
        # 時系列パターン分析
        if len(gx_vals) >= 4:
            mid_point = len(gx_vals) // 2
            stats["gx_stability_trend"] = self._calculate_stability_trend(gx_vals, mid_point)
            stats["gz_stability_trend"] = self._calculate_stability_trend(gz_vals, mid_point)
        else:
            stats["gx_stability_trend"] = 0
            stats["gz_stability_trend"] = 0
        
        return stats
    
    def validate_sample_size(self, data: List[Any]) -> bool:
        """サンプルサイズの妥当性を検証"""
        return data is not None and len(data) >= self.MIN_SAMPLE_SIZE
    
    def get_confidence_level(self) -> float:
        """信頼水準を取得"""
        return self.CONFIDENCE_LEVEL
    
    def _calculate_stability_trend(self, values: List[float], mid_point: int) -> float:
        """安定性トレンドを計算"""
        if mid_point <= 1:
            return 0.0
        first_half_std = statistics.pstdev(values[:mid_point])
        second_half_std = statistics.pstdev(values[mid_point:])
        return second_half_std - first_half_std
    
    def _get_empty_stats(self) -> Dict[str, float]:
        """空の統計を返す"""
        return {
            "avg_speed": 0, "mean_gx": 0, "mean_gz": 0,
            "std_gx": 0, "std_gz": 0, "max_gx": 0, "max_gz": 0,
            "min_gx": 0, "min_gz": 0, "median_gx": 0, "median_gz": 0,
            "std_speed": 0, "max_speed": 0, "min_speed": 0,
            "median_speed": 0, "speed_range": 0,
            "acceleration_count": 0, "deceleration_count": 0,
            "sharp_turn_count": 0, "data_points": 0,
            "gx_stability_trend": 0, "gz_stability_trend": 0
        }


# ===== フォーカス評価器 =====
class FocusEvaluator(EvaluatorBase):
    """フォーカスポイント評価クラス"""
    
    MIN_SCORE = 40
    MAX_SCORE = 100
    EXCELLENT_THRESHOLD = 95
    GOOD_THRESHOLD = 80
    AVERAGE_THRESHOLD = 60
    
    def __init__(self, focus_type: str, statistics_calculator: StatisticsCalculator):
        self._focus_type = focus_type
        self._statistics_calculator = statistics_calculator
        self._score_cache: Dict[str, float] = {}
    
    def evaluate(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """評価を実行"""
        if not self.validate_data(data):
            return self._get_not_passed_result()
        
        stats = data.get('stats', {})
        rating, score = self._calculate_rating_and_score(stats)
        
        return {
            'rating': rating,
            'score': score,
            'stats': stats,
            'passed': True
        }
    
    def calculate_score(self, stats: Dict[str, float]) -> float:
        """スコアを計算"""
        if not stats or all(v == 0 for v in stats.values()):
            return 0
        
        gx = abs(stats.get("mean_gx", 0))
        gz = abs(stats.get("mean_gz", 0))
        std_gx = stats.get("std_gx", 0)
        std_gz = stats.get("std_gz", 0)
        
        score = 70.0  # ベーススコア
        
        # フォーカスタイプ別のスコア計算
        if self._focus_type in ["brake_soft", "stop_smooth"]:
            score = 100 - (abs(gz) - 0.10) * 400 - (std_gz - 0.04) * 500
        elif self._focus_type == "accel_smooth":
            score = 100 - (gz - 0.10) * 400 - (std_gz - 0.04) * 500
        elif self._focus_type == "turn_stability":
            score = 100 - (gx - 0.10) * 400 - (std_gx - 0.05) * 500
        elif self._focus_type == "smooth_overall":
            score = 100 - (std_gx - 0.04) * 600 - (std_gz - 0.04) * 600
        elif self._focus_type == "speed_consistency":
            speed_std = stats.get("std_speed", 0)
            score = 100 - (speed_std - 2.0) * 15
        
        return self._clamp_score(score, self.MIN_SCORE, self.MAX_SCORE)
    
    def validate_data(self, data: Dict[str, Any]) -> bool:
        """データの妥当性を検証"""
        return data is not None and 'stats' in data
    
    def get_rating_from_score(self, score: float) -> str:
        """スコアから評価を取得"""
        if score >= self.EXCELLENT_THRESHOLD:
            return "とてもいい"
        elif score >= self.GOOD_THRESHOLD:
            return "いい"
        elif score >= self.AVERAGE_THRESHOLD:
            return "ふつう"
        else:
            return "わるい"
    
    def _calculate_rating_and_score(self, stats: Dict[str, float]) -> Tuple[str, int]:
        """評価とスコアを計算"""
        score = self.calculate_score(stats)
        rating = self.get_rating_from_score(score)
        return rating, int(round(score))
    
    def _clamp_score(self, score: float, min_val: float, max_val: float) -> float:
        """スコアをクランプ"""
        return max(min_val, min(max_val, score))
    
    def _get_not_passed_result(self) -> Dict[str, Any]:
        """通過しなかった場合の結果を返す"""
        return {
            'rating': "なし",
            'score': 0,
            'stats': {},
            'passed': False
        }


# ===== Gemini AI戦略 =====
class GeminiAIStrategy(AIGenerationStrategy):
    """Gemini を使用したAI生成戦略"""
    
    MAX_RETRIES = 3
    TIMEOUT_SECONDS = 30
    MAX_TOKENS = 500
    
    def __init__(self, model_name: str = "gemini-2.0-flash"):
        self._model_name = model_name
        self._model: Optional[genai.GenerativeModel] = None
        self._api_key: Optional[str] = None
        self._initialize_model()
    
    def generate_comment(self, stats: Dict[str, float], context: Dict[str, Any]) -> str:
        """詳細なフィードバックコメントを生成"""
        if self._model is None:
            return "AIフィードバック用の設定がまだ完了していないため、自動コメントを生成できませんでした。"
        
        prompt = self._build_prompt(stats, context)
        
        try:
            response = self._model.generate_content(prompt)
            feedback_text = (response.text or "").strip()
            
            if not feedback_text:
                return "AIフィードバックの生成結果が空でした。"
            
            return feedback_text
            
        except Exception as e:
            print(f"⚠️ AI生成エラー (Gemini): {e}")
            return "AIフィードバック生成中にエラーが発生しました。"
    
    def summarize(self, text: str, max_length: int = 150) -> str:
        """テキストを要約"""
        if self._model is None:
            return text[:max_length]
        
        prompt = f"""
        以下のフィードバック文を{max_length}文字以内に要約してください。
        - 最も重要なポイント2つに絞る
        - 優しい口調を維持
        - 簡潔でわかりやすく
        - 絵文字を1つ含める
        
        【元の文章】
        {text}
        """
        
        try:
            response = self._model.generate_content(prompt)
            summary = (response.text or "").strip()
            return summary if summary else text[:max_length]
        except Exception as e:
            print(f"⚠️ 要約生成エラー: {e}")
            return text[:max_length]
    
    def get_model_name(self) -> str:
        """モデル名を取得"""
        return self._model_name
    
    def _initialize_model(self) -> None:
        """モデルを初期化"""
        self._api_key = os.getenv("GEMINI_API_KEY")
        if not self._api_key:
            print("⚠️ GEMINI_API_KEY が環境変数に設定されていません。")
            return
        
        try:
            genai.configure(api_key=self._api_key)
            self._model = genai.GenerativeModel(self._model_name)
        except Exception as e:
            print(f"⚠️ Gemini 初期化エラー: {e}")
            self._model = None
    
    def _build_prompt(self, stats: Dict[str, float], context: Dict[str, Any]) -> str:
        """プロンプトを構築"""
        focus_type_name = context.get('focus_type_name', '不明')
        rating = context.get('rating', '不明')
        diff_text = context.get('diff_text', '')
        historical_data = context.get('historical_data', [])
        raw_data = context.get('raw_data', [])
        
        # 過去データとの比較
        historical_comparison = self._format_historical_comparison(historical_data, stats)
        
        # 生データのフォーマット
        raw_data_text = self._format_raw_data(raw_data)
        
        return f"""
あなたは運転コーチAI『ドライボ』です。
この地点は「{focus_type_name}」を意識するよう設定されていました。
以下の**実際の計測データすべて**をもとに、今回の運転の特徴と改善点をコメントしてください。

{raw_data_text}

【統計サマリー】
- 平均速度: {stats.get('avg_speed', 0):.1f} km/h（最高 {stats.get('max_speed', 0):.1f} km/h、最低 {stats.get('min_speed', 0):.1f} km/h）
- データ計測点数: {stats.get('data_points', 0)}点
- 急加速: {stats.get('acceleration_count', 0)}回
- 急ブレーキ: {stats.get('deceleration_count', 0)}回
- 急ハンドル: {stats.get('sharp_turn_count', 0)}回

【前回との直接比較】
{diff_text}
{historical_comparison}

【今回の総合評価】
{rating}

出力条件（厳守）:
- 上記の時系列データから運転パターンを分析してください
- **具体的な秒数や速度の数値は言及しない**
- 時間表現は「最初は」「途中で」「前半は」「後半は」「全体的に」のような抽象的な表現のみ
- 速度表現は「ほぼ一定」「少し変動」「停止した場面」のような定性的な表現のみ
- 専門用語や数値(Gx, Gzなど)を使わず、わかりやすい言葉で説明する
- 優しい口調で3〜5文程度
- 良くなった点、安定している点、改善できる点をバランス良く述べる
- 最後に前向きな一言と絵文字を添える
"""
    
    def _format_historical_comparison(self, historical_data: List[Dict], current_stats: Dict[str, float]) -> str:
        """過去データとの比較をフォーマット"""
        if not historical_data:
            return ""
        
        comparison = "\n【過去の走行との比較】\n"
        for i, hist in enumerate(historical_data[:3], 1):
            hist_stats = hist.get("stats", {})
            hist_rating = hist.get("rating", "不明")
            
            if i == 1:
                comparison += f"- 前回: 評価「{hist_rating}」"
            else:
                comparison += f"- {i}回前: 評価「{hist_rating}」"
            
            if hist_stats:
                std_gx_compare = current_stats.get("std_gx", 0) - hist_stats.get("std_gx", 0)
                std_gz_compare = current_stats.get("std_gz", 0) - hist_stats.get("std_gz", 0)
                
                if std_gx_compare < -0.02 or std_gz_compare < -0.02:
                    comparison += "（今回の方が安定）\n"
                elif std_gx_compare > 0.02 or std_gz_compare > 0.02:
                    comparison += "（今回の方が不安定）\n"
                else:
                    comparison += "（ほぼ同じ）\n"
        
        return comparison
    
    def _format_raw_data(self, raw_data: List[Dict]) -> str:
        """生データをフォーマット"""
        if not raw_data:
            return ""
        
        formatted = "\n【この地点の全計測データ（時系列）】\n"
        formatted += "時刻, 左右G(gx), 前後G(gz), 速度(km/h)\n"
        for i, point in enumerate(raw_data, 1):
            formatted += f"{i}, {point.get('gx', 0):.3f}, {point.get('gz', 0):.3f}, {point.get('speed', 0):.1f}\n"
        
        formatted += "\n※ 左右G(gx): 正=右旋回、負=左旋回\n"
        formatted += "※ 前後G(gz): 正=加速、負=減速\n"
        
        return formatted


# ===== 比較分析ヘルパー =====
class ComparisonAnalyzer:
    """比較分析クラス"""
    
    THRESHOLD = 0.01
    
    @staticmethod
    def compare_stats(prev_stats: Optional[Dict], current_stats: Dict) -> Tuple[Optional[Dict], str]:
        """統計データを比較"""
        if not prev_stats:
            return None, "前回データが見つからなかったため、今回は単独での評価です。"
        
        diff = ComparisonAnalyzer._calculate_diff(prev_stats, current_stats)
        diff_text = ComparisonAnalyzer._generate_diff_text(diff)
        
        return diff, diff_text
    
    @staticmethod
    def _calculate_diff(prev_stats: Dict, current_stats: Dict) -> Dict[str, float]:
        """差分を計算"""
        return {
            "avg_speed_diff": current_stats.get("avg_speed", 0) - prev_stats.get("avg_speed", 0),
            "gx_diff": current_stats.get("mean_gx", 0) - prev_stats.get("mean_gx", 0),
            "gz_diff": current_stats.get("mean_gz", 0) - prev_stats.get("mean_gz", 0),
            "std_gx_diff": current_stats.get("std_gx", 0) - prev_stats.get("std_gx", 0),
            "std_gz_diff": current_stats.get("std_gz", 0) - prev_stats.get("std_gz", 0),
            "max_gx_diff": current_stats.get("max_gx", 0) - prev_stats.get("max_gx", 0),
            "max_gz_diff": current_stats.get("max_gz", 0) - prev_stats.get("max_gz", 0),
            "acceleration_count_diff": current_stats.get("acceleration_count", 0) - prev_stats.get("acceleration_count", 0),
            "deceleration_count_diff": current_stats.get("deceleration_count", 0) - prev_stats.get("deceleration_count", 0),
            "sharp_turn_count_diff": current_stats.get("sharp_turn_count", 0) - prev_stats.get("sharp_turn_count", 0),
        }
    
    @staticmethod
    def _generate_diff_text(diff: Dict[str, float]) -> str:
        """差分テキストを生成"""
        def trend(value: float, positive_text: str, negative_text: str, threshold: float = 0.01) -> str:
            if abs(value) < threshold:
                return "ほとんど変わりませんでした"
            elif value < 0:
                return positive_text
            else:
                return negative_text
        
        gz_trend = trend(
            diff["std_gz_diff"],
            "前後の揺れが少なくなり、加減速がより滑らかになっています",
            "前後の揺れが少し増え、加減速がやや急になっています"
        )
        
        gx_trend = trend(
            diff["std_gx_diff"],
            "左右の揺れが落ち着き、ハンドル操作が安定しています",
            "左右の揺れがやや増えて、カーブでの安定感が下がっています"
        )
        
        speed_trend = trend(
            diff["avg_speed_diff"],
            "平均速度はやや低下し、落ち着いたペースになりました",
            "平均速度はやや上昇し、全体的に速めの走行となっています"
        )
        
        return f"{gz_trend}。{gx_trend}。{speed_trend}。"


# ===== レガシー互換関数 =====
NOT_PASSED_STATS = {
    "avg_speed": 0, "mean_gx": 0, "mean_gz": 0,
    "std_gx": 0, "std_gz": 0, "max_gx": 0, "max_gz": 0,
    "min_gx": 0, "min_gz": 0, "median_gx": 0, "median_gz": 0,
    "max_speed": 0, "min_speed": 0, "median_speed": 0,
    "speed_range": 0, "acceleration_count": 0, "deceleration_count": 0,
    "sharp_turn_count": 0, "data_points": 0
}
NOT_PASSED_COMMENT = "この重点ポイントは今回の走行で通過しなかったようです。次回、挑戦してみましょう！"

# グローバルインスタンス
_statistics_calculator = DetailedStatisticsCalculator()
_ai_strategy = GeminiAIStrategy()


def get_gemini_model(model_name: str = "gemini-2.0-flash"):
    """レガシー互換: Gemini モデルを取得"""
    strategy = GeminiAIStrategy(model_name)
    return strategy._model


def get_time_window_for_focus(focus_type: str) -> Tuple[int, int]:
    """レガシー互換: フォーカスタイプごとのデータ範囲設定"""
    if focus_type in ["brake_soft", "stop_smooth"]:
        return 8000, 3000
    elif focus_type in ["accel_smooth"]:
        return 3000, 8000
    elif focus_type in ["turn_stability"]:
        return 4000, 4000
    else:
        return 8000, 8000


def get_focus_rating(stats: Dict, focus_type: str) -> Tuple[str, int]:
    """レガシー互換: フォーカス評価"""
    evaluator = FocusEvaluator(focus_type, _statistics_calculator)
    result = evaluator.evaluate({'stats': stats})
    return result['rating'], result['score']


def calculate_detailed_stats(gx_vals: List[float], gz_vals: List[float], speeds: List[float]) -> Dict[str, float]:
    """レガシー互換: 詳細統計計算"""
    data = [{'g_x': gx, 'g_z': gz, 'speed': spd} for gx, gz, spd in zip(gx_vals, gz_vals, speeds)]
    return _statistics_calculator.calculate(data)


def compare_focus_stats(prev_stats: Optional[Dict], current_stats: Dict) -> Tuple[Optional[Dict], str]:
    """レガシー互換: 統計比較"""
    return ComparisonAnalyzer.compare_stats(prev_stats, current_stats)


def generate_ai_focus_feedback(
    focus_type_name: str,
    current_stats: Dict,
    diff: Optional[Dict],
    rating: str,
    diff_text: str,
    historical_data: Optional[List] = None,
    raw_data: Optional[List] = None
) -> str:
    """レガシー互換: AIフィードバック生成"""
    context = {
        'focus_type_name': focus_type_name,
        'rating': rating,
        'diff_text': diff_text,
        'historical_data': historical_data or [],
        'raw_data': raw_data or []
    }
    return _ai_strategy.generate_comment(current_stats, context)


def summarize_feedback(ai_comment: str, diff_text: str, max_length: int = 150) -> str:
    """レガシー互換: フィードバック要約"""
    return _ai_strategy.summarize(ai_comment, max_length)


def get_historical_stats(user_id: str, session_id: str, pin_id: str, limit: int = 3) -> List[Dict]:
    """レガシー互換: 過去の走行データ取得"""
    prev_sessions = (
        db.collection("sessions")
        .where("user_id", "==", user_id)
        .where("status", "==", "completed")
        .order_by("end_time", direction=firestore.Query.DESCENDING)
        .stream()
    )
    
    historical_data = []
    for sdoc in prev_sessions:
        if sdoc.id == session_id:
            continue
        
        fb_ref = db.collection("sessions").document(sdoc.id)\
            .collection("focus_feedbacks").document(pin_id)
        
        fb_doc = fb_ref.get()
        if fb_doc.exists:
            fb_data = fb_doc.to_dict()
            stats = fb_data.get("stats")
            if stats and any(v != 0 for v in stats.values()):
                historical_data.append({
                    "session_id": sdoc.id,
                    "stats": stats,
                    "rating": fb_data.get("rating"),
                    "created_at": fb_data.get("created_at")
                })
                if len(historical_data) >= limit:
                    break
    
    return historical_data


# analyze_focus_points_for_session などの主要関数は元のai_evaluation.pyをそのまま使用
# （長すぎるため、リファクタリング版では基盤クラスのみ提供）
