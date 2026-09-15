// Shared venue-location picker used by the public order form and both admin
// order forms. Leaflet + CARTO's free basemap tiles (built for embedding in
// apps like this one — unlike osm.org's own raw tile server, which explicitly
// blocks non-browsing/app usage per its tile usage policy and will 403 a
// deployed app like this with "Access blocked"). Free-text search is
// geocoded via Nominatim (OpenStreetMap's public geocoder, a separate
// service from the tile server and fine for this volume of use).
function initVenueMap(opts) {
  var mapEl = document.getElementById(opts.mapId);
  if (!mapEl || typeof L === 'undefined') return;

  var latInput = document.getElementById(opts.latInputId);
  var lngInput = document.getElementById(opts.lngInputId);
  var hasInitial = opts.initialLat !== null && opts.initialLat !== undefined && opts.initialLat !== '' &&
                    opts.initialLng !== null && opts.initialLng !== undefined && opts.initialLng !== '';
  var startLat = hasInitial ? parseFloat(opts.initialLat) : 33.5138; // Damascus, just a sane default center
  var startLng = hasInitial ? parseFloat(opts.initialLng) : 36.2765;

  var map = L.map(opts.mapId).setView([startLat, startLng], hasInitial ? 15 : 11);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  }).addTo(map);

  var marker = null;

  function writeCoords(lat, lng) {
    latInput.value = lat.toFixed(6);
    lngInput.value = lng.toFixed(6);
  }

  function bindDrag(m) {
    m.on('dragend', function () {
      var pos = m.getLatLng();
      writeCoords(pos.lat, pos.lng);
    });
  }

  function placeMarker(lat, lng) {
    if (marker) {
      marker.setLatLng([lat, lng]);
    } else {
      marker = L.marker([lat, lng], { draggable: true }).addTo(map);
      bindDrag(marker);
    }
    writeCoords(lat, lng);
  }

  if (hasInitial) placeMarker(startLat, startLng);

  map.on('click', function (e) {
    placeMarker(e.latlng.lat, e.latlng.lng);
  });

  var searchInput = document.getElementById(opts.searchInputId);
  var searchBtn = document.getElementById(opts.searchBtnId);
  if (searchBtn && searchInput) {
    var runSearch = function (e) {
      if (e) e.preventDefault();
      var q = searchInput.value.trim();
      if (!q) return;
      searchBtn.disabled = true;
      fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (results) {
          searchBtn.disabled = false;
          if (!results.length) {
            alert('لم يتم العثور على هذا الموقع، جرّب صياغة أخرى.');
            return;
          }
          var lat = parseFloat(results[0].lat);
          var lng = parseFloat(results[0].lon);
          map.setView([lat, lng], 16);
          placeMarker(lat, lng);
        })
        .catch(function () {
          searchBtn.disabled = false;
          alert('تعذر البحث عن الموقع، تحقق من الاتصال بالإنترنت.');
        });
    };
    searchBtn.addEventListener('click', runSearch);
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') runSearch(e);
    });
  }

  // Leaflet mis-sizes maps created inside containers that were just inserted
  // or were hidden at mount time — nudge it once the layout has settled.
  setTimeout(function () { map.invalidateSize(); }, 200);
}
