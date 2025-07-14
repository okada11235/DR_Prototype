let watchId, accelHandler, startTime;

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');

startBtn.onclick = () => {
  resetSensors();
  startTime = new Date();
  route = [];
  distance = 0;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  initMap();

  watchId = navigator.geolocation.watchPosition(trackPosition, null, { enableHighAccuracy: true });
  accelHandler = handleMotion;
  window.addEventListener('devicemotion', accelHandler);
};

stopBtn.onclick = () => {
  const endTime = new Date();
  navigator.geolocation.clearWatch(watchId);
  window.removeEventListener('devicemotion', accelHandler);

  const { rapidStart, rapidBrake, sharpTurn } = getSensorData();
  const record = {
    userId: user.uid,
    timestamp: Date.now(),
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    distance: parseFloat(distance.toFixed(2)),
    acceleration_events: { rapidStart, rapidBrake, sharpTurn },
    route: route
  };
  db.collection('drive_records').add(record);
  showChart(rapidStart, rapidBrake, sharpTurn);
  startBtn.disabled = false;
  stopBtn.disabled = true;
};
