function showChart(start, brake, turn) {
  new Chart(document.getElementById('chart'), {
    type: 'bar',
    data: {
      labels: ['急発進', '急ブレーキ', '急カーブ'],
      datasets: [{
        label: 'イベント回数',
        data: [start, brake, turn],
        borderWidth: 1
      }]
    },
    options: {
      scales: { y: { beginAtZero: true } }
    }
  });
}