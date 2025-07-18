window.onload = function() {
  sessionsData.forEach(session => {
    // === 棒グラフ描画 (Chart.js) ===
    const ctx = document.getElementById(`chart-${session.id}`).getContext('2d');
    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['急発進', '急ブレーキ', '急カーブ', '法定速度超過'],
        datasets: [{
          label: '回数',
          data: [
            session.sudden_accels || 0,
            session.sudden_brakes || 0,
            session.sharp_turns || 0,
            session.speed_violations || 0
          ],
          backgroundColor: [
            'rgba(255, 99, 132, 0.5)',
            'rgba(54, 162, 235, 0.5)',
            'rgba(255, 206, 86, 0.5)',
            'rgba(75, 192, 192, 0.5)'
          ],
          borderColor: [
            'rgba(255, 99, 132, 1)',
            'rgba(54, 162, 235, 1)',
            'rgba(255, 206, 86, 1)',
            'rgba(75, 192, 192, 1)'
          ],
          borderWidth: 1
        }]
      },
      options: {
        scales: {
          y: { beginAtZero: true, precision: 0 }
        }
      }
    });

    // === Google Map描画 ===
    const gpsLogs = session.gps_logs || [];
    const path = gpsLogs.map(log => ({
      lat: parseFloat(log.latitude),
      lng: parseFloat(log.longitude)
    }));

    const map = new google.maps.Map(document.getElementById(`map-${session.id}`), {
      zoom: 14,
      center: path.length > 0 ? path[0] : { lat: 35.681236, lng: 139.767125 }  // 東京駅
    });

    const polyline = new google.maps.Polyline({
      path,
      geodesic: true,
      strokeColor: '#FF0000',
      strokeOpacity: 1.0,
      strokeWeight: 2,
      map: map
    });

    // イベントマーカーの色定義
    const eventColors = {
      sudden_accel: 'green',
      sudden_brake: 'red',
      sharp_turn: 'orange',
      speed_violation: 'purple'
    };

    // イベントマーカーを立てる
    gpsLogs.forEach(log => {
      if (log.event && log.event !== 'normal' && log.latitude && log.longitude) {
        new google.maps.Marker({
          position: { lat: parseFloat(log.latitude), lng: parseFloat(log.longitude) },
          map: map,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 6,
            fillColor: eventColors[log.event] || 'gray',
            fillOpacity: 1,
            strokeWeight: 1,
            strokeColor: '#000'
          }
        });
      }
    });
  });
};
