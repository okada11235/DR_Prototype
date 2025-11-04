// permissions.js - ログイン時に必要権限をまとめて要求

export async function requestMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    localStorage.setItem('perm_mic', 'granted');
    console.log('✅ Microphone permission granted');
    return { ok: true };
  } catch (e) {
    console.warn('⚠️ Microphone permission failed:', e);
    localStorage.setItem('perm_mic', 'denied');
    return { ok: false, error: e };
  }
}

export async function requestGeolocation() {
  if (!('geolocation' in navigator)) {
    console.warn('Geolocation not supported');
    return { ok: false, error: new Error('not supported') };
  }
  return new Promise((resolve) => {
    const done = (ok, error) => {
      localStorage.setItem('perm_geo', ok ? 'granted' : 'denied');
      if (ok) console.log('✅ Geolocation permission granted');
      else console.warn('⚠️ Geolocation permission failed:', error);
      resolve({ ok, error });
    };
    try {
      navigator.geolocation.getCurrentPosition(
        () => done(true),
        (err) => done(false, err),
        { enableHighAccuracy: false, maximumAge: 0, timeout: 8000 }
      );
    } catch (e) {
      done(false, e);
    }
  });
}

export async function requestMotion() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      const ok = r === 'granted';
      localStorage.setItem('perm_motion', ok ? 'granted' : 'denied');
      console.log(`Motion permission: ${r}`);
      return { ok };
    }
    // Android/PCは不要
    localStorage.setItem('perm_motion', 'granted');
    return { ok: true };
  } catch (e) {
    console.warn('⚠️ Motion permission failed:', e);
    localStorage.setItem('perm_motion', 'denied');
    return { ok: false, error: e };
  }
}

export async function requestAllPermissions() {
  const results = { mic: null, geo: null, motion: null };
  // 既に許可済みならスキップ
  const micDone = localStorage.getItem('perm_mic') === 'granted';
  const geoDone = localStorage.getItem('perm_geo') === 'granted';
  const motionDone = localStorage.getItem('perm_motion') === 'granted';

  if (!micDone) results.mic = await requestMicrophone();
  else results.mic = { ok: true, cached: true };

  if (!geoDone) results.geo = await requestGeolocation();
  else results.geo = { ok: true, cached: true };

  if (!motionDone) results.motion = await requestMotion();
  else results.motion = { ok: true, cached: true };

  const allOk = (results.mic?.ok !== false) && (results.geo?.ok !== false) && (results.motion?.ok !== false);
  localStorage.setItem('perm_all', allOk ? 'granted' : 'partial');
  return { allOk, results };
}
