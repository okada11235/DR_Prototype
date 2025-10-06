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