// utils.js - ユーティリティ関数

console.log('=== utils.js LOADED ===');

// 時間をフォーマットする関数
export function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
}

// 安定度を計算する関数
export function calculateStability(accels, brakes, turns, distance) {
    if (distance === 0) return 100;
    const totalEvents = accels + brakes + turns;
    const eventDensity = totalEvents / distance;
    let stability = Math.max(0, 100 - (eventDensity * 20));
    return Math.round(stability);
}

// タイマー処理
export function startTimer() {
    window.timerInterval = setInterval(() => {
        const elapsed = Date.now() - window.startTime;
        const mins = Math.floor(elapsed / 60000).toString().padStart(2, '0');
        const secs = Math.floor((elapsed % 60000) / 1000).toString().padStart(2, '0');
        const timerElement = document.getElementById('timer');
        if (timerElement) {
            timerElement.textContent = `${mins}:${secs}`;
        }
    }, 1000);
}

export function stopTimer() {
    clearInterval(window.timerInterval);
}


// === スコア管理機能 =====================================================

// 初期化：スコアオブジェクトを作成
export function initScores() {
    window.scores = {
        accel: 100,
        brake: 100,
        turn: 100,
        straight: 100,
    };
    window.scoreHistory = [];
    console.log("🏁 Scores initialized:", window.scores);
}

// 現在のスコアスナップショットを取得
export function getScoreSnapshot() {
    if (!window.scores) initScores();
    const s = window.scores;
    const overall = Math.round((s.accel + s.brake + s.turn + s.straight) / 4);
    return { ...s, overall };
}

// リアルタイムスコア更新
export function updateRealtimeScore(type, delta, meta = {}) {
    if (!window.scores) initScores();
    if (!window.scores[type]) window.scores[type] = 100;

    // スコアを更新（下限60〜上限100）
    const newScore = Math.max(60, Math.min(100, window.scores[type] + delta));
    window.scores[type] = newScore;

    // 履歴記録
    window.scoreHistory.push({
        type,
        delta,
        newScore,
        timestamp: Date.now(),
        ...meta
    });

    console.log(`🎯 Score updated [${type}] => ${newScore} (${delta > 0 ? "+" : ""}${delta})`);
}

// スコア履歴をリセット（必要に応じて呼ぶ）
export function resetScoreHistory() {
    window.scoreHistory = [];
}
