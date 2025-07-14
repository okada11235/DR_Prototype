let rapidStart = 0, rapidBrake = 0, sharpTurn = 0;

function handleMotion(event) {
  const ax = event.acceleration.x;
  const ay = event.acceleration.y;

  if (ax > 5) rapidStart++;
  if (ax < -5) rapidBrake++;
  if (Math.abs(ay) > 5) sharpTurn++;
}

function resetSensors() {
  rapidStart = rapidBrake = sharpTurn = 0;
}

function getSensorData() {
  return { rapidStart, rapidBrake, sharpTurn };
}