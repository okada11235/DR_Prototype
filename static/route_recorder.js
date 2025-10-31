// route_recorder.js - 重点ポイント用のルート記録（GPSのみ、助言/音声なし）

console.log("=== route_recorder.js LOADED ===");

// ローカルストレージキー
const LS_ROUTE_ACTIVE = "priorityRouteRecordingActive";
const LS_ROUTE_ID = "priorityRouteId";
const LS_USER_ID = "CURRENT_USER_ID";
const LS_ROUTE_START = "priorityRouteStartTime";

// 状態
window.priorityRoute = {
  watchId: null,
  buffer: [],
  bufferFlushMs: 5000,
  lastFlush: 0,
};

function ensureFirebaseInitialized() {
  // recording_start.html 側で初期化済みの想定
  // ただし home.html などでも動くように保険をかける
  if (window.firebase && window.firebase.apps && window.firebase.apps.length > 0) {
    return;
  }
  if (!window.firebase) {
    console.warn("Firebase SDK not loaded. route_recorder requires firebase-app-compat.js and firestore-compat.js");
    return;
  }
  // 既に他ページで保存してある可能性が高い
  const existing = localStorage.getItem("FIREBASE_CONFIG_JSON");
  if (existing) {
    try {
      const cfg = JSON.parse(existing);
      firebase.initializeApp(cfg);
    } catch (e) {
      console.warn("Failed to parse FIREBASE_CONFIG_JSON:", e);
    }
  }
}

function getUserId() {
  return window.FLASK_USER_ID || localStorage.getItem(LS_USER_ID) || null;
}

async function createRouteDoc() {
  const userId = getUserId();
  const docRef = await firebase.firestore().collection("priority_routes").add({
    user_id: userId,
    status: "recording",
    created_at: new Date(),
    updated_at: new Date(),
  });
  return docRef.id;
}

async function savePointsBatch(routeId, points) {
  if (!points || points.length === 0) return;
  const db = firebase.firestore();
  const batch = db.batch();
  const col = db.collection("priority_routes").doc(routeId).collection("points");
  points.forEach((p) => {
    const ref = col.doc();
    batch.set(ref, {
      lat: p.lat,
      lng: p.lng,
      timestamp_ms: p.timestamp_ms || Date.now(),
      created_at: new Date(),
    });
  });
  await batch.commit();
  // ルートの更新時刻を更新
  await db.collection("priority_routes").doc(routeId).update({ updated_at: new Date() });
}

async function findLatestRouteIdForUser() {
  const db = firebase.firestore();
  const userId = getUserId();
  let routeDoc = null;
  if (userId) {
    const qs = await db.collection('priority_routes').where('user_id', '==', userId).get();
    if (qs.empty) return null;
    routeDoc = qs.docs.reduce((latest, d) => {
      const data = d.data();
      const curTs = (data.updated_at?.toMillis?.() ? data.updated_at.toMillis() : (data.updated_at?.getTime?.() || 0))
                 || (data.created_at?.toMillis?.() ? data.created_at.toMillis() : (data.created_at?.getTime?.() || 0));
      if (!latest) return { doc: d, ts: curTs };
      return curTs > latest.ts ? { doc: d, ts: curTs } : latest;
    }, null)?.doc || null;
  } else {
    const qs = await db.collection('priority_routes').orderBy('updated_at', 'desc').limit(1).get();
    if (qs.empty) return null;
    routeDoc = qs.docs[0];
  }
  return routeDoc ? routeDoc.id : null;
}

async function findActiveRouteIdForUser() {
  const db = firebase.firestore();
  const userId = getUserId();
  if (userId) {
    const qs = await db.collection('priority_routes')
      .where('user_id', '==', userId)
      .where('status', '==', 'recording')
      .limit(1)
      .get();
    if (!qs.empty) return qs.docs[0].id;
    return null;
  }
  // ユーザーIDが無い場合はアクティブ検出不可
  return null;
}

function startWatch(routeId) {
  if (!('geolocation' in navigator)) {
    alert('この端末では位置情報が利用できません');
    return;
  }
  // 既存をクリア
  if (window.priorityRoute.watchId != null) {
    navigator.geolocation.clearWatch(window.priorityRoute.watchId);
  }
  window.priorityRoute.buffer = [];
  window.priorityRoute.lastFlush = Date.now();

  window.priorityRoute.watchId = navigator.geolocation.watchPosition(async (pos) => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const ts = Date.now();

    // バッファに溜める
    window.priorityRoute.buffer.push({ lat, lng, timestamp_ms: ts });

    // 一定間隔で一括保存
    const now = ts;
    if (now - window.priorityRoute.lastFlush >= window.priorityRoute.bufferFlushMs) {
      const toSave = window.priorityRoute.buffer.slice();
      window.priorityRoute.buffer = [];
      window.priorityRoute.lastFlush = now;
      try {
        await savePointsBatch(routeId, toSave);
        console.log(`🚚 Saved ${toSave.length} route points.`);
      } catch (e) {
        console.error('Failed to save route points:', e);
        // 失敗したら次回に再送するため戻す
        window.priorityRoute.buffer.unshift(...toSave);
      }
    }
  }, (err) => {
    console.error('route watchPosition error:', err);
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
}

async function flushRemaining(routeId) {
  const buf = window.priorityRoute.buffer.slice();
  window.priorityRoute.buffer = [];
  if (buf.length > 0) {
    try {
      await savePointsBatch(routeId, buf);
    } catch (e) {
      console.error('Failed to flush remaining points:', e);
    }
  }
}

async function stopWatch(routeId, markCompleted = true) {
  if (window.priorityRoute.watchId != null) {
    navigator.geolocation.clearWatch(window.priorityRoute.watchId);
    window.priorityRoute.watchId = null;
  }
  await flushRemaining(routeId);
  if (markCompleted) {
    try {
      await firebase.firestore().collection("priority_routes").doc(routeId).update({ status: 'completed', updated_at: new Date() });
    } catch (e) {
      console.warn('failed to mark route completed:', e);
    }
  }
}

// 公開API
window.priorityRouteAPI = {
  async getLatestRouteId() {
    try {
      ensureFirebaseInitialized();
      const id = await findLatestRouteIdForUser();
      return id;
    } catch (e) {
      console.warn('getLatestRouteId failed:', e);
      return null;
    }
  },
  async getActiveRouteId() {
    try {
      ensureFirebaseInitialized();
      return await findActiveRouteIdForUser();
    } catch (e) {
      console.warn('getActiveRouteId failed:', e);
      return null;
    }
  },
  async start() {
    try {
      ensureFirebaseInitialized();
      const userId = getUserId();
      if (!userId) {
        // user_id は可能なら保存（recording_start.html から渡せる）
        console.warn('User ID not found. Route will be created without user_id filter.');
      }
      const id = await createRouteDoc();
      localStorage.setItem(LS_ROUTE_ID, id);
      localStorage.setItem(LS_ROUTE_ACTIVE, 'true');
      localStorage.setItem(LS_ROUTE_START, String(Date.now()));
      // センサー/助言停止のためグローバルフラグ
      window.ROUTE_RECORDING_ACTIVE = true;
      // 連携用にユーザーIDも保存（homeで継続録画するため）
      if (window.FLASK_USER_ID) localStorage.setItem(LS_USER_ID, window.FLASK_USER_ID);

      startWatch(id);
      console.log('🏁 Route recording started:', id);
      return id;
    } catch (e) {
      console.error('Failed to start route recording:', e);
      alert('ルート記録の開始に失敗しました');
      throw e;
    }
  },
  async stop(markCompleted = true) {
    const id = localStorage.getItem(LS_ROUTE_ID);
    if (!id) return;
    await stopWatch(id, markCompleted);
    localStorage.removeItem(LS_ROUTE_ACTIVE);
    localStorage.removeItem(LS_ROUTE_ID);
    localStorage.removeItem(LS_ROUTE_START);
    window.ROUTE_RECORDING_ACTIVE = false;
    console.log('🛑 Route recording stopped');
  },
  async deleteActiveRoute() {
    ensureFirebaseInitialized();
    let id = localStorage.getItem(LS_ROUTE_ID);
    if (!id) {
      // アクティブでなければ最新のルートを探して削除
      try {
        id = await findLatestRouteIdForUser();
      } catch (e) {
        console.error('最新ルート検索に失敗:', e);
      }
      if (!id) {
        alert('削除できるルートがありません');
        return;
      }
    }
    try {
      // まず停止
      await stopWatch(id, false);
      // サブコレクション削除
      const db = firebase.firestore();
      const pointsRef = db.collection('priority_routes').doc(id).collection('points');
      const snap = await pointsRef.get();
      const batch = db.batch();
      snap.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      await db.collection('priority_routes').doc(id).delete();
      localStorage.removeItem(LS_ROUTE_ACTIVE);
      localStorage.removeItem(LS_ROUTE_ID);
      localStorage.removeItem(LS_ROUTE_START);
      window.ROUTE_RECORDING_ACTIVE = false;
      alert('ルートを削除しました');
    } catch (e) {
      console.error('Failed to delete route:', e);
      alert('ルート削除に失敗しました');
    }
  },
  isActive() {
    return localStorage.getItem(LS_ROUTE_ACTIVE) === 'true';
  },
  getActiveRouteId() {
    return localStorage.getItem(LS_ROUTE_ID);
  },
  getRouteStartTime() {
    const v = localStorage.getItem(LS_ROUTE_START);
    return v ? Number(v) : null;
  }
};

// ページ遷移後でも継続できるよう、自動再開
document.addEventListener('DOMContentLoaded', () => {
  try {
    ensureFirebaseInitialized();
    const active = localStorage.getItem(LS_ROUTE_ACTIVE) === 'true';
    const routeId = localStorage.getItem(LS_ROUTE_ID);
    if (active && routeId && window.priorityRoute.watchId == null) {
      console.log('🔁 Resuming route recording for', routeId);
      window.ROUTE_RECORDING_ACTIVE = true; // 助言停止
      // 開始時刻がなければ今をセット
      if (!localStorage.getItem(LS_ROUTE_START)) {
        localStorage.setItem(LS_ROUTE_START, String(Date.now()));
      }
      startWatch(routeId);
    }
  } catch (e) {
    console.warn('Failed to auto-resume route recording:', e);
  }
});
