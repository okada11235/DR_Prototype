let map, polyline, lastLatLng;
let route = [], distance = 0;

function initMap() {
  map = new google.maps.Map(document.getElementById('map'), {
    zoom: 15,
    center: { lat: 0, lng: 0 }
  });
  polyline = new google.maps.Polyline({ map, path: [], strokeColor: '#FF0000' });
}

function trackPosition(pos) {
  const latLng = new google.maps.LatLng(pos.coords.latitude, pos.coords.longitude);
  polyline.getPath().push(latLng);
  map.panTo(latLng);

  if (lastLatLng) {
    const d = google.maps.geometry.spherical.computeDistanceBetween(lastLatLng, latLng);
    distance += d / 1000;
  }
  lastLatLng = latLng;
  route.push({ lat: pos.coords.latitude, lng: pos.coords.longitude, time: Date.now() });
}