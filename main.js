document.addEventListener('DOMContentLoaded', function() {
  // -----------------------
  // 1. API KEYS & CONFIG
  // -----------------------
  const OWM_KEY = '9505fd1df737e20152fbd78cdb289b6a';
  const TOMTOM_KEY = 'YHB95ZB47iFTcDkDqOerQM6sgbsNomKr';
  const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?units=metric&appid=${OWM_KEY}`;
  const forecastUrlBase = `https://api.openweathermap.org/data/2.5/forecast?units=metric&appid=${OWM_KEY}`;
  const aqiUrl = `https://api.openweathermap.org/data/3.0/stations?appid=${OWM_KEY}`;
  // Additional configuration
  const TOLL_RATE_INR = 100; // default per-toll cost for a 4-wheeler
  const EMISSION_G_PER_KM_4W = 192; // g CO2 per km for an average 4-wheeler
  const TOLL_PROXIMITY_KM = 0.4; // within 400m consider toll on route
  const OSRM_ROUTE_BASE = 'https://router.project-osrm.org/route/v1';
  let aqiPieChart = null;
  let liveTempInterval = null;
  let lastCityPolling = null;

  // -----------------------
  // 2. GLOBAL AI MEMORY
  // -----------------------
  let aiWeatherData = null;   // Current weather
  let aiForecastData = null;  // 5-day forecast
  let aiAqiData = null;       // Air quality data

  // -----------------------
  // 3. DOM ELEMENTS
  // -----------------------
  const form = document.querySelector("form");
  const startInput = document.getElementById('start');
  const endInput = document.getElementById('end');
  const routeButton = document.getElementById('route-button');
  const routeResultDiv = document.getElementById('route-result');
  const valueSearch = document.getElementById('name');
  const voiceBtn = document.getElementById('voice-search');
  const useMyLocationBtn = document.getElementById('use-my-location');
  const forecastDiv = document.getElementById('forecast');
  const pastForecastDiv = document.getElementById('past-forecast');
  const historyList = document.getElementById('history-list');
  const aqiCurrentDiv = document.getElementById('aqi-current');
  const vehicleRecDiv = document.getElementById('vehicle-recommendations');
  const indoorAqiDiv = document.getElementById('indoor-aqi-display');
  const purifierDiv = document.getElementById('purifier-suggestions');
  const routeAqiDiv = document.getElementById('route-aqi-display');

  // -----------------------
  // 4. MAP INITIALIZATION
  // -----------------------
  const map = L.map('map').setView([28.6738, 77.4458], 10);
  let routeLayers = L.layerGroup().addTo(map);
  let startMarker = null;
  let endMarker = null;

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);

  // -----------------------
  // 5. EVENT LISTENERS
  // -----------------------
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (valueSearch.value.trim() !== '') searchWeather(valueSearch.value.trim());
    });
  }

  if (routeButton) {
    routeButton.addEventListener('click', async () => {
      // Run existing routing flow, then analyze tolls/CO2 on the rendered route(s)
      try {
        await planRoute();
        // small delay to allow routeLayers to be populated
        setTimeout(() => {
          analyzeTollsForRenderedRoutes().catch(err => console.warn('Toll analysis failed', err));
        }, 600);
      } catch (e) {
        console.error('Error planning route', e);
      }
    });
  }

  // -----------------------
  // 6. HISTORY LOGIC
  // -----------------------
  function loadHistory() {
    try {
      const raw = localStorage.getItem('weather_history');
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }
  
  function saveSearch(city) {
    if (!city) return;
    const list = loadHistory();
    const normalized = city.trim();
    const idx = list.findIndex(i => i.toLowerCase() === normalized.toLowerCase());
    if (idx !== -1) list.splice(idx,1);
    list.unshift(normalized);
    if (list.length > 10) list.pop();
    localStorage.setItem('weather_history', JSON.stringify(list));
    renderHistory();
  }
  
  function renderHistory() {
    if (!historyList) return;
    const list = loadHistory();
    historyList.innerHTML = '';
    for (const item of list) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = item;
      btn.className = 'history-btn'; 
      btn.addEventListener('click', () => {
        valueSearch.value = item;
        searchWeather(item);
      });
      li.appendChild(btn);
      historyList.appendChild(li);
    }
  }

  // -----------------------
  // 7. ORIGINAL VOICE SEARCH
  // -----------------------
  if (voiceBtn && 'webkitSpeechRecognition' in window) {
    const recognition = new webkitSpeechRecognition();
    recognition.lang = 'en-IN';
    recognition.continuous = false;
    recognition.interimResults = false;

    voiceBtn.addEventListener('click', () => {
      voiceBtn.disabled = true;
      voiceBtn.querySelector('i').classList.add('fa-spin');
      recognition.start();
    });

    recognition.onresult = function(event) {
      let transcript = event.results[0][0].transcript.trim();
      if (transcript.endsWith('.')) transcript = transcript.slice(0, -1);
      valueSearch.value = transcript;
      searchWeather(transcript);
    };
    recognition.onend = function() {
      voiceBtn.disabled = false;
      voiceBtn.querySelector('i').classList.remove('fa-spin');
    };
  }

  // -----------------------
  // 8. GEOLOCATION
  // -----------------------
  if (useMyLocationBtn && navigator.geolocation) {
    useMyLocationBtn.addEventListener('click', function() {
      useMyLocationBtn.disabled = true;
      useMyLocationBtn.innerText = "Getting location...";
      navigator.geolocation.getCurrentPosition(
        async function(position) {
          const lat = position.coords.latitude;
          const lon = position.coords.longitude;
          try {
            const res = await fetch(`https://api.tomtom.com/search/2/reverseGeocode/${lat},${lon}.json?key=${TOMTOM_KEY}`);
            const data = await res.json();
            let address = `${lat},${lon}`;
            if (data.addresses && data.addresses.length > 0) {
              address = data.addresses[0].address.freeformAddress;
            }
            startInput.value = address;
            useMyLocationBtn.innerText = "Use My Location";
            useMyLocationBtn.disabled = false;
            if (endInput.value.trim() !== '') planRoute();
          } catch (err) {
            startInput.value = `${lat},${lon}`;
            useMyLocationBtn.disabled = false;
          }
        },
        function(error) {
          alert("Could not get your location.");
          useMyLocationBtn.innerText = "Use My Location";
          useMyLocationBtn.disabled = false;
        }
      );
    });
  }

  // -----------------------
  // 9. WEATHER FUNCTIONS (UPDATED FOR CHATBOX)
  // -----------------------
  function searchWeather(cityName) {
    fetch(`${weatherUrl}&q=${encodeURIComponent(cityName)}`)
      .then(res => res.json())
      .then(async data => {
        const errorEl = document.getElementById('error-message');
        if (data.cod !== 200) {
          if (errorEl) { errorEl.style.display = 'block'; errorEl.innerText = data.message || "City not found!"; } 
          else { alert(data.message || "City not found!"); }
          pushAiBotMessage(`Could not find weather for ${cityName}.`);
          return;
        }
        if (errorEl) errorEl.style.display = 'none';

        // Update UI
        document.querySelector('.result .name figcaption').innerText = data.name;
        document.querySelector('.result .name img').src = `https://flagsapi.com/${data.sys.country}/shiny/32.png`;
        document.querySelector('.result .temperature img').src = `https://openweathermap.org/img/wn/${data.weather[0].icon}@4x.png`;
        document.querySelector('.result .temperature span').innerText = data.main.temp.toFixed(2).padStart(5, '0');
        document.querySelector('.result .description').innerText = data.weather[0].description;
        document.getElementById('clouds').innerText = data.clouds.all;
        document.getElementById('humidity').innerText = data.main.humidity;
        document.getElementById('pressure').innerText = data.main.pressure;

        // *** AI MEMORY & RESPONSE ***
          aiWeatherData = data; 
          // Render AQI pie and start live temp polling for this city
          try {
            if (data.coord && data.coord.lat && data.coord.lon) fetchAndRenderAQIPie(data.coord.lat, data.coord.lon).catch(()=>{});
            startLiveTempPolling(data.name, 300000);
          } catch(e) { console.warn('Post-search tasks failed', e); }
        // THIS LINE MAKES IT SHOW IN CHATBOX:
        pushAiBotMessage(`🌤️ **Weather in ${data.name}:** ${data.weather[0].description}, ${data.main.temp}°C.`);
        
        saveSearch(cityName);
        const days = await fetchForecast(cityName);
        aiForecastData = days; // AI Memory
        renderForecast(days);

        const lat = data.coord && data.coord.lat;
        const lon = data.coord && data.coord.lon;
        if (lat != null && lon != null) {
          const past = await fetchPastFiveDays(lat, lon);
          renderPastForecast(past);
          const aqiData = await fetchAQI(lat, lon);
          displayAQI(aqiData);
        } else {
          renderPastForecast(null);
        }
      });
  }

  async function fetchForecast(city) {
     try {
       const res = await fetch(`${forecastUrlBase}&q=${encodeURIComponent(city)}`);
       const data = await res.json();
       if (!data || (data.cod && data.cod !== "200" && data.cod !== 200)) return null;
       
       const byDate = {};
       (data.list || []).forEach(item => {
         const date = item.dt_txt.split(' ')[0];
         (byDate[date] = byDate[date] || []).push(item);
       });
       const dates = Object.keys(byDate).slice(0,5);
       return dates.map(date => {
         const arr = byDate[date];
         const pick = arr.reduce((best, cur) => {
           const target = 12;
           const bestHour = parseInt(best.dt_txt.split(' ')[1].split(':')[0],10);
           const curHour = parseInt(cur.dt_txt.split(' ')[1].split(':')[0],10);
           return Math.abs(curHour - target) < Math.abs(bestHour - target) ? cur : best;
         });
         return {
           date,
           temp: pick.main.temp,
           icon: pick.weather[0].icon,
           desc: pick.weather[0].description
         };
       });
     } catch (e) { return null; }
   }
   
   function renderForecast(days) {
     if (!forecastDiv) return;
     forecastDiv.innerHTML = '';
     if (!days || days.length === 0) { forecastDiv.style.display = 'none'; return; }
     forecastDiv.style.display = 'flex';
     for (const d of days) {
       const el = document.createElement('div');
       el.style.textAlign = 'center';
       el.style.padding = '6px';
       el.style.border = '1px solid #eee';
       el.style.borderRadius = '6px';
       el.style.minWidth = '90px';
       const dateStr = new Date(d.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
       el.innerHTML = `
         <div style="font-size:12px;color:#333;margin-bottom:4px">${dateStr}</div>
         <div><img src="https://openweathermap.org/img/wn/${d.icon}@2x.png" alt="${d.desc}" style="width:48px;height:48px"></div>
         <div style="font-weight:600">${d.temp.toFixed(1)}°C</div>
         <div style="font-size:12px;color:#666">${d.desc}</div>
       `;
       forecastDiv.appendChild(el);
     }
   }

   async function fetchPastFiveDays(lat, lon) {
     try {
       const now = Math.floor(Date.now() / 1000);
       const daySeconds = 24 * 60 * 60;
       const results = [];
       for (let i = 5; i >= 1; i--) {
         const dt = now - i * daySeconds;
         const url = `https://api.openweathermap.org/data/2.5/onecall/timemachine?lat=${lat}&lon=${lon}&dt=${dt}&units=metric&appid=${OWM_KEY}`;
         const res = await fetch(url);
         if (!res.ok) continue;
         const data = await res.json();
         if (!data || !data.hourly || data.hourly.length === 0) continue;
         let best = data.hourly[0];
         for (const h of data.hourly) {
           const hour = new Date(h.dt * 1000).getUTCHours();
           const bestHour = new Date(best.dt * 1000).getUTCHours();
           if (Math.abs(hour - 12) < Math.abs(bestHour - 12)) best = h;
         }
         results.push({
           date: new Date(best.dt * 1000).toISOString().split('T')[0],
           temp: best.temp,
           icon: best.weather && best.weather[0] ? best.weather[0].icon : '01d',
           desc: best.weather && best.weather[0] ? best.weather[0].description : ''
         });
       }
       return results;
     } catch (e) { return null; }
   }
   
   function renderPastForecast(days) {
     if (!pastForecastDiv) return;
     pastForecastDiv.innerHTML = '';
     if (!days || days.length === 0) { pastForecastDiv.style.display = 'none'; return; }
     pastForecastDiv.style.display = 'flex';
     for (const d of days) {
       const el = document.createElement('div');
       el.style.textAlign = 'center';
       el.style.padding = '6px';
       el.style.border = '1px solid #eee';
       el.style.borderRadius = '6px';
       el.style.minWidth = '90px';
       const dateStr = new Date(d.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
       el.innerHTML = `
         <div style="font-size:12px;color:#333;margin-bottom:4px">${dateStr}</div>
         <div><img src="https://openweathermap.org/img/wn/${d.icon}@2x.png" alt="${d.desc}" style="width:48px;height:48px"></div>
         <div style="font-weight:600">${d.temp.toFixed(1)}°C</div>
         <div style="font-size:12px;color:#666">${d.desc}</div>
       `;
       pastForecastDiv.appendChild(el);
     }
   }

  // -----------------------
  // 10. AQI FUNCTIONS
  // -----------------------
  async function fetchAQI(lat, lon) {
    try {
      const url = `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${OWM_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data && data.list && data.list[0]) {
        aiAqiData = data.list[0]; // AI Memory
        return data.list[0];
      }
      return null;
    } catch (e) { return null; }
  }

  function getAQILevel(aqi) {
    if (aqi === 1) return { level: 'Good', class: 'aqi-good', icon: '✓', message: 'Air quality is satisfactory.' };
    if (aqi === 2) return { level: 'Fair', class: 'aqi-moderate', icon: '⚠', message: 'Air quality is acceptable.' };
    if (aqi === 3) return { level: 'Moderate', class: 'aqi-moderate', icon: '⚠', message: 'Members of sensitive groups may experience health effects.' };
    if (aqi === 4) return { level: 'Poor', class: 'aqi-unhealthy', icon: '✕', message: 'Everyone may begin to experience health effects.' };
    if (aqi === 5) return { level: 'Very Poor', class: 'aqi-hazardous', icon: '✕', message: 'Health alerts: Avoid outdoor activities.' };
    return { level: 'Unknown', class: 'aqi-moderate', icon: '?', message: 'AQI data unavailable.' };
  }

  function getVehicleRecommendations(aqi) {
    const recommendations = {
      1: [
        { vehicle: '🚴 Bicycling', recommendation: 'Excellent choice! Safe for outdoor cycling.' },
        { vehicle: '🏃 Walking', recommendation: 'Perfect conditions for walking and outdoor exercise.' },
        { vehicle: '🚗 Car', recommendation: 'All vehicles suitable. No restrictions.' }
      ],
      2: [
        { vehicle: '🚴 Bicycling', recommendation: 'Acceptable, but sensitive groups should be cautious.' },
        { vehicle: '🏃 Walking', recommendation: 'Generally safe. Sensitive groups should limit intensity.' },
        { vehicle: '🚗 Car', recommendation: 'All vehicles suitable.' }
      ],
      3: [
        { vehicle: '🚴 Bicycling', recommendation: 'Not recommended. Consider using car or public transport.' },
        { vehicle: '🏃 Walking', recommendation: 'Not recommended. Limit outdoor exposure.' },
        { vehicle: '🚗 Car', recommendation: 'Recommended. Keep windows closed; use AC recirculation.' }
      ],
      4: [
        { vehicle: '🚴 Bicycling', recommendation: 'Avoid. Air quality too poor for cycling.' },
        { vehicle: '🏃 Walking', recommendation: 'Avoid. Use car or stay indoors.' },
        { vehicle: '🚗 Car', recommendation: 'Recommended. Keep windows closed and use cabin air filter.' }
      ],
      5: [
        { vehicle: '🚴 Bicycling', recommendation: 'Strictly avoid cycling.' },
        { vehicle: '🏃 Walking', recommendation: 'Stay indoors. Do not go outside.' },
        { vehicle: '🚗 Car', recommendation: 'Only if necessary. Minimize outdoor exposure.' }
      ]
    };
    return recommendations[aqi] || recommendations[1];
  }

  const airPurifiers = [
    { name: 'Dyson Pure Cool', rating: 4.8, aqi_range: '3-5', price: '$$$', features: 'HEPA + Activated Carbon, Quiet', url: 'https://www.dyson.com/air-treatment/purifiers/dyson-pure-cool' },
    { name: 'Coway Airmega', rating: 4.7, aqi_range: '3-5', price: '$$', features: 'HEPA, Smart sensor, Energy efficient', url: 'https://www.coway.com/products/air-purifiers' },
    { name: 'Philips AC2889', rating: 4.6, aqi_range: '2-5', price: '$$', features: 'VitaShield IPS, Whisper quiet', url: 'https://www.philips.com/c-m-ac/air-purifiers' },
    { name: 'Levoit Core 300', rating: 4.5, aqi_range: '2-4', price: '$', features: 'HEPA, Budget-friendly, Compact', url: 'https://www.levoit.com/products/core-300-air-purifier' },
    { name: 'Honeywell HPA300', rating: 4.4, aqi_range: '2-5', price: '$$', features: 'True HEPA, Large room coverage', url: 'https://www.honeywellhomestore.com/products/air-purifiers' }
  ];

  function getPurifierSuggestions(aqi) {
    if (aqi <= 2) {
      return '<div style="color: #28a745;">✓ Air quality is good. No purifier needed at this time.</div>';
    }
    const suitable = airPurifiers.filter(p => {
      const range = p.aqi_range.split('-');
      return parseInt(range[0]) <= aqi && parseInt(range[1]) >= aqi;
    });
    let html = '<div style="font-weight: bold; margin-bottom: 8px;">Recommended Air Purifiers:</div>';
    suitable.forEach(p => {
      html += `<div class="purifier-item">
        <strong><a href="${p.url}" target="_blank" style="color: #007bff; text-decoration: none;">${p.name}</a></strong><br>
        Rating: ⭐ ${p.rating} | Price: ${p.price}<br>
        Features: ${p.features}<br>
        <a href="${p.url}" target="_blank" style="color: #007bff; font-size: 0.9em; text-decoration: none;">View Product →</a>
      </div>`;
    });
    return html;
  }

  function displayAQI(aqiData) {
    if (!aqiData) {
      document.getElementById('aqi-level').innerText = 'N/A';
      document.getElementById('aqi-value').innerText = 'AQI data unavailable';
      return;
    }
    const aqi = aqiData.main.aqi;
    const components = aqiData.components || {};
    const info = getAQILevel(aqi);
    
    document.getElementById('aqi-level').innerHTML = `${info.icon} ${info.level}`;
    document.getElementById('aqi-value').innerText = `AQI Level: ${aqi}/5`;
    
    const pollutants = [];
    if (components.pm25) pollutants.push(`PM2.5: ${components.pm25.toFixed(1)} µg/m³`);
    if (components.pm10) pollutants.push(`PM10: ${components.pm10.toFixed(1)} µg/m³`);
    if (components.o3) pollutants.push(`O₃: ${components.o3.toFixed(1)} ppb`);
    if (components.no2) pollutants.push(`NO₂: ${components.no2.toFixed(1)} ppb`);
    document.getElementById('aqi-main-pollutant').innerText = pollutants.join(' | ');
    
    const alertEl = document.getElementById('aqi-health-alert');
    alertEl.className = info.class;
    alertEl.innerHTML = `<strong>${info.level.toUpperCase()}</strong><br>${info.message}`;
    
    const vehicles = getVehicleRecommendations(aqi);
    vehicleRecDiv.innerHTML = '';
    vehicles.forEach(v => {
      const div = document.createElement('div');
      div.className = 'vehicle-item';
      div.innerHTML = `<strong>${v.vehicle}</strong><br>${v.recommendation}`;
      vehicleRecDiv.appendChild(div);
    });
    
    indoorAqiDiv.innerHTML = `<strong>Current AQI Level:</strong> ${info.level}<br>`;
    if (aqi >= 3) {
      indoorAqiDiv.innerHTML += '⚠️ <strong>Recommended:</strong> Keep windows closed. Use air purifier if available.';
      purifierDiv.innerHTML = getPurifierSuggestions(aqi);
    } else {
      indoorAqiDiv.innerHTML += '✓ <strong>Good air quality:</strong> You can safely open windows.';
      purifierDiv.innerHTML = '<div style="color: #28a745;">No air purifier needed at this time.</div>';
    }

    // Render pollution awareness tab with current AQI level
    renderPollutionAwareness(aqi);
  }

  async function checkAQIAlongRoute(coordinates) {
    const promises = [];
    const numPoints = Math.min(coordinates.length, 5);
    const step = Math.floor(coordinates.length / (numPoints > 1 ? numPoints - 1 : 1));

    for (let i = 0; i < coordinates.length; i += step) {
      const [lat, lon] = coordinates[i];
      promises.push(fetchAQI(lat, lon));
    }

    const results = await Promise.all(promises);
    const avgAqi = results.reduce((sum, data) => sum + (data ? data.main.aqi : 0), 0) / results.length;
    return { avgAqi: Math.round(avgAqi), points: results };
  }

  function displayRouteAQI(aqiInfo) {
    if (!routeAqiDiv) return;
    routeAqiDiv.innerHTML = '';
    if (!aqiInfo) return;
    
    const info = getAQILevel(Math.round(aqiInfo.avgAqi));
    const div = document.createElement('div');
    div.className = 'route-aqi-item';
    div.innerHTML = `<strong>Average AQI along route:</strong> ${info.level} (${aqiInfo.avgAqi}/5)<br>
      <small>${info.message}</small>`;
    routeAqiDiv.appendChild(div);
  }

  // -----------------------
  // 11.a Toll & CO2 helpers
  // -----------------------
  function haversine(a, b) {
    // a = [lat, lon], b = [lat, lon]
    const toRad = v => v * Math.PI / 180;
    const R = 6371; // km
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const sinDlat = Math.sin(dLat/2);
    const sinDlon = Math.sin(dLon/2);
    const aa = sinDlat*sinDlat + Math.cos(lat1)*Math.cos(lat2)*sinDlon*sinDlon;
    const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
    return R * c; // km
  }

  function getBBoxFromCoords(coords) {
    // coords: array of [lat, lon]
    let minLat = 90, minLon = 180, maxLat = -90, maxLon = -180;
    for (const p of coords) {
      minLat = Math.min(minLat, p[0]);
      minLon = Math.min(minLon, p[1]);
      maxLat = Math.max(maxLat, p[0]);
      maxLon = Math.max(maxLon, p[1]);
    }
    // pad slightly
    const padLat = (maxLat - minLat) * 0.07 || 0.05;
    const padLon = (maxLon - minLon) * 0.07 || 0.05;
    return { south: minLat - padLat, west: minLon - padLon, north: maxLat + padLat, east: maxLon + padLon };
  }

  async function queryTollBoothsOverpass(bbox) {
    // bbox {south,west,north,east}
    const q = `[out:json][timeout:25];(node["barrier"="toll_booth"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out body;`;
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: `data=${encodeURIComponent(q)}`
      });
      const json = await res.json();
      return (json && json.elements) ? json.elements.map(n => ({ lat: n.lat, lon: n.lon, tags: n.tags || {} })) : [];
    } catch (e) {
      console.warn('Overpass query failed', e);
      return [];
    }
  }

  function countTollsNearRoute(routeCoords, tollNodes, thresholdKm = TOLL_PROXIMITY_KM) {
    let count = 0;
    const seen = new Set();
    for (const node of tollNodes) {
      for (const pt of routeCoords) {
        const d = haversine([pt.lat || pt[0], pt.lng || pt[1]], [node.lat, node.lon]);
        if (d <= thresholdKm) {
          const key = `${node.lat}-${node.lon}`;
          if (!seen.has(key)) { seen.add(key); count++; }
          break;
        }
      }
    }
    return count;
  }

  async function getOSRMRoutes(startLat, startLon, endLat, endLon) {
    const url = `${OSRM_ROUTE_BASE}/driving/${startLon},${startLat};${endLon},${endLat}?overview=full&alternatives=true&geometries=geojson`;
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (!j || !j.routes) return [];
      return j.routes.map(rt => ({ distance: rt.distance, duration: rt.duration, geometry: rt.geometry }));
    } catch (e) {
      console.warn('OSRM routes fetch failed', e);
      return [];
    }
  }

  async function analyzeTollsForRenderedRoutes() {
    // examine polylines in routeLayers
    if (!routeLayers) return;
    const layers = routeLayers.getLayers ? routeLayers.getLayers() : [];
    if (!layers || layers.length === 0) return;
    // pick the first polyline as primary route
    const primary = layers.find(l => l instanceof L.Polyline) || layers[0];
    if (!primary) return;
    const latlngs = primary.getLatLngs ? primary.getLatLngs() : [];
    if (!latlngs || latlngs.length === 0) return;

    // convert to simple [lat,lon] arrays
    const coords = latlngs.map(p => [p.lat, p.lng]);
    const bbox = getBBoxFromCoords(coords);
    const tollNodes = await queryTollBoothsOverpass(bbox);
    const primaryTollCount = countTollsNearRoute(latlngs, tollNodes);

    // compute distance from polyline if available
    let distanceKm = 0;
    for (let i = 1; i < coords.length; i++) distanceKm += haversine(coords[i-1], coords[i]);

    const primaryCost = primaryTollCount * TOLL_RATE_INR;
    const primaryCO2g = Math.round(distanceKm * EMISSION_G_PER_KM_4W);

    // If start/end available, try OSRM alternatives to compare tolls and pick avoid-toll
    const start = coords[0]; const end = coords[coords.length-1];
    const osrmRoutes = await getOSRMRoutes(start[0], start[1], end[0], end[1]);
    const alternatives = [];
    for (const rt of osrmRoutes) {
      // extract geojson coords (lon,lat) -> convert
      const pts = (rt.geometry && rt.geometry.coordinates) ? rt.geometry.coordinates.map(c => ({ lat: c[1], lon: c[0] })) : [];
      const tollCount = countTollsNearRoute(pts, tollNodes);
      const distKm = (rt.distance || 0) / 1000;
      const cost = tollCount * TOLL_RATE_INR;
      const co2 = Math.round(distKm * EMISSION_G_PER_KM_4W);
      alternatives.push({ tollCount, cost, co2, distKm });
    }

    // Choose best alternative for avoiding tolls (fewer tolls while reasonable distance)
    let bestAlt = null;
    if (alternatives.length > 0) {
      bestAlt = alternatives.reduce((acc, cur) => {
        if (!acc) return cur;
        if (cur.tollCount < acc.tollCount) return cur;
        return acc;
      }, null);
    }

    renderTollResults({ primaryTollCount, primaryCost, primaryCO2g, distanceKm, alternatives, bestAlt });
  }

  function renderTollResults({ primaryTollCount, primaryCost, primaryCO2g, distanceKm, alternatives, bestAlt }) {
    const tollEl = document.getElementById('toll-info');
    const co2El = document.getElementById('co2-info');
    const altEl = document.getElementById('alt-route-info');
    if (co2El) {
      co2El.style.display = 'block';
      co2El.innerHTML = `<strong>Distance:</strong> ${distanceKm.toFixed(1)} km &nbsp;|&nbsp; Estimated CO₂: ${primaryCO2g.toLocaleString()} g (for a 4-wheeler)`;
    }
    if (altEl) {
      if (!bestAlt || bestAlt.tollCount >= primaryTollCount) {
        altEl.style.display = 'block';
        altEl.innerHTML = `<strong>Alternate routes:</strong> No clear toll-avoiding alternative found among quick alternatives.`;
      } else {
        const savedMoney = primaryCost - bestAlt.cost;
        const savedCO2 = primaryCO2g - bestAlt.co2;
        altEl.style.display = 'block';
        altEl.innerHTML = `<strong>Better alternative found:</strong> Toll plazas: ${bestAlt.tollCount} (cost ₹${bestAlt.cost}).<br>`+
          `<strong>Savings:</strong> ₹${savedMoney} &nbsp;|&nbsp; CO₂ saved ≈ ${savedCO2} g &nbsp;|&nbsp; Alt distance: ${bestAlt.distKm.toFixed(1)} km`;
      }
    }
  }

  // -----------------------
  // 11.b AQI Pie & live temp
  // -----------------------
  async function fetchAndRenderAQIPie(lat, lon) {
    if (!lat || !lon) return;
    try {
      const resp = await fetch(`https://api.openweathermap.org/data/2.5/air_pollution/forecast?lat=${lat}&lon=${lon}&appid=${OWM_KEY}`);
      const j = await resp.json();
      if (!j || !j.list) return;
      // count AQI categories using returned main.aqi (1..5)
      const counts = { 1:0,2:0,3:0,4:0,5:0 };
      for (const it of j.list.slice(0, 24)) {
        const a = it.main && it.main.aqi ? it.main.aqi : 1;
        counts[a] = (counts[a] || 0) + 1;
      }
      const labels = ['Good (1)','Fair (2)','Moderate (3)','Poor (4)','Very Poor (5)'];
      const data = [counts[1], counts[2], counts[3], counts[4], counts[5]];
      const colors = ['#28a745','#ffc107','#ff9800','#e74c3c','#6a0572'];
      const ctx = document.getElementById('aqi-pie').getContext('2d');
      if (aqiPieChart) aqiPieChart.destroy();
      aqiPieChart = new Chart(ctx, {
        type: 'pie', data: { labels, datasets: [{ data, backgroundColor: colors }] },
        options: { plugins: { legend: { display: true, position: 'bottom' } } }
      });
      // textual legend
      const legendEl = document.getElementById('aqi-pie-legend');
      if (legendEl) {
        legendEl.innerHTML = labels.map((lbl,i)=>`<span style="display:inline-block;margin-right:8px;color:${colors[i]}">●</span> ${lbl} (${data[i]})`).join(' &nbsp; ');
      }
    } catch (e) { console.warn('AQI pie fetch failed', e); }
  }

  function startLiveTempPolling(city, intervalMs = 300000) {
    if (!city) return;
    if (liveTempInterval && lastCityPolling === city) return; // already polling
    stopLiveTempPolling();
    lastCityPolling = city;
    async function poll() {
      try {
        const r = await fetch(`${weatherUrl}&q=${encodeURIComponent(city)}`);
        const d = await r.json();
        if (d && d.main) {
          const el = document.getElementById('live-temp');
          if (el) el.innerHTML = `<strong>Live temp:</strong> ${d.main.temp.toFixed(1)}°C &nbsp;|&nbsp; ${d.weather && d.weather[0] ? d.weather[0].description : ''}`;
          // also update small UI temperature if present
          const tempSpan = document.querySelector('.result .temperature span');
          if (tempSpan) tempSpan.innerText = d.main.temp.toFixed(2).padStart(5,'0');
        }
      } catch (e) { console.warn('Live temp fetch failed', e); }
    }
    poll();
    liveTempInterval = setInterval(poll, intervalMs);
  }

  function stopLiveTempPolling() {
    if (liveTempInterval) { clearInterval(liveTempInterval); liveTempInterval = null; lastCityPolling = null; }
  }

  // -----------------------
  // 11.c Air Pollution Awareness
  // -----------------------
  const pollutionAwarenessData = {
    problems: [
      { title: 'Respiratory Diseases', desc: 'Long-term exposure increases asthma, bronchitis, and lung cancer risk.' },
      { title: 'Cardiovascular Issues', desc: 'Pollution particles enter bloodstream, causing heart attacks and strokes.' },
      { title: 'Reduced Visibility', desc: 'Smog and particulates reduce air clarity, causing traffic accidents and poor visibility.' },
      { title: 'Skin & Eye Irritation', desc: 'Pollutants irritate skin and eyes, especially in children and elderly.' },
      { title: 'Climate Change', desc: 'Pollution contributes to greenhouse gas emissions and global warming.' },
      { title: 'Premature Death', desc: 'WHO reports ~7 million premature deaths annually from air pollution.' }
    ],
    causes: [
      { title: 'Vehicle Emissions', desc: 'Cars, trucks, and buses emit NOx, CO, PM2.5, and CO2.' },
      { title: 'Industrial Pollution', desc: 'Factories release heavy metals, SO2, and particulates into air.' },
      { title: 'Power Plants', desc: 'Coal-fired power stations emit large amounts of CO2 and PM2.5.' },
      { title: 'Construction & Dust', desc: 'Dust from construction sites and roads increases PM10 levels.' },
      { title: 'Burning Crop Residue', desc: 'Farmers burning stubble during harvest season causes seasonal spikes.' },
      { title: 'Biomass Burning', desc: 'Cooking fires and biomass burning contribute to indoor and outdoor pollution.' },
      { title: 'Wildfires', desc: 'Forest fires release massive amounts of PM2.5 and smoke across regions.' }
    ],
    precautions: [
      { title: 'Use Air Purifiers', desc: 'Install HEPA filters at home to remove 99.97% of harmful particles.' },
      { title: 'Wear N95/PM2.5 Masks', desc: 'Wear certified masks outdoors during high pollution days. Fit properly for effectiveness.' },
      { title: 'Limit Outdoor Activity', desc: 'Avoid strenuous exercise outside when AQI > 150. Exercise indoors instead.' },
      { title: 'Close Windows', desc: 'Keep windows and doors closed on high pollution days; use AC with recirculation mode.' },
      { title: 'Use Air Purifier Bags', desc: 'Activated charcoal and HEPA pouches can improve air quality in small spaces.' },
      { title: 'Protect Eyes & Skin', desc: 'Wear sunglasses and long sleeves to reduce exposure to pollutants.' },
      { title: 'Check AQI Daily', desc: 'Monitor local AQI forecasts to plan outdoor activities accordingly.' },
      { title: 'Use Eco-Friendly Transport', desc: 'Use public transport, carpool, or cycle to reduce personal vehicle emissions.' },
      { title: 'Maintain Vehicle', desc: 'Regular maintenance and emission testing reduce vehicle pollution output.' },
      { title: 'Plant Trees', desc: 'Trees absorb CO2 and particulates; plant more for cleaner air.' }
    ],
    articles: [
      { title: 'WHO Air Quality Guidelines', url: 'https://www.who.int/publications/i/item/9789240034228' },
      { title: 'Health Effects of Air Pollution', url: 'https://www.heart.org/en/healthy-living/healthy-air' },
      { title: 'PM2.5 & Health: EPA Guide', url: 'https://www.epa.gov/pmdesignations/health-and-environmental-effects-particulate-matter-pm' },
      { title: 'Air Quality Index Explained', url: 'https://www.airnow.gov/aqi/' },
      { title: 'DIY Air Purifier Tips', url: 'https://www.consumerreports.org/cro/air-purifiers/buying-guide/index.htm' },
      { title: 'Mask Effectiveness Study', url: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7680547/' },
      { title: 'Climate & Air Quality', url: 'https://climate.nasa.gov/news/3012/how-air-quality-relates-to-climate-change/' }
    ]
  };

  const healthAlertData = {
    1: { // Good
      level: 'Good (AQI 1)',
      color: '#28a745',
      maskAdvice: 'No mask required. Air quality is excellent.',
      safetyTools: [],
      activities: 'All outdoor activities are safe. Enjoy outdoor exercise!'
    },
    2: { // Fair
      level: 'Fair (AQI 2)',
      color: '#ffc107',
      maskAdvice: 'Masks not required. Air quality is acceptable for most people.',
      safetyTools: [],
      activities: 'Most outdoor activities are safe. Sensitive groups should limit strenuous activity.'
    },
    3: { // Moderate
      level: 'Moderate (AQI 3)',
      color: '#ff9800',
      maskAdvice: '⚠️ Wear N95 or PM2.5 mask if going outdoors for extended periods.',
      safetyTools: ['N95 Mask', 'PM2.5 Mask (KN95/FFP2)', 'Portable Air Purifier', 'Face Shield'],
      activities: 'Sensitive groups (children, elderly, asthmatics) should limit outdoor time.'
    },
    4: { // Poor
      level: 'Poor (AQI 4)',
      color: '#e74c3c',
      maskAdvice: '⚠️⚠️ MUST wear N95/PM2.5 mask outdoors. Wear it properly (cover nose & mouth).',
      safetyTools: ['N95/KN95 Certified Mask', 'Respirator with Cartridge', 'Home HEPA Air Purifier', 'Air Purifier Bag', 'Activated Charcoal Filter', 'Humidifier with Purifier'],
      activities: 'Avoid outdoor activities. Stay indoors with windows closed. Run air purifiers.'
    },
    5: { // Very Poor / Hazardous
      level: 'Hazardous (AQI 5)',
      color: '#6a0572',
      maskAdvice: '🚨 CRITICAL: Wear high-grade respirator (P100/N100 mask). Avoid all outdoor activity.',
      safetyTools: ['P100/N100 Respirator Mask', 'Full-Face Respirator', 'Industrial HEPA Air Purifier', 'Multiple Air Purifier Units', 'Activated Charcoal + HEPA Combo', 'Professional Air Filtration System'],
      activities: '🚨 STAY INDOORS. Avoid all outdoor exposure. Work from home if possible.'
    }
  };

  function renderPollutionAwareness(currentAQI = 1) {
    const contentDiv = document.getElementById('pollution-tab-content');
    const tabButtons = document.querySelectorAll('.pollution-tab-btn');
    if (!contentDiv || tabButtons.length === 0) return;

    // Set up tab click handlers
    tabButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        tabButtons.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        const tabName = e.target.getAttribute('data-tab');
        renderTabContent(tabName, currentAQI);
      });
    });

    // Render default tab (Problems)
    renderTabContent('problems', currentAQI);
  }

  function renderTabContent(tabName, currentAQI) {
    const contentDiv = document.getElementById('pollution-tab-content');
    if (!contentDiv) return;
    contentDiv.innerHTML = '';

    if (tabName === 'problems') {
      contentDiv.innerHTML = '<h4>🏥 Air Pollution Health Problems</h4>';
      pollutionAwarenessData.problems.forEach(p => {
        contentDiv.innerHTML += `<div style="margin:10px 0;padding:8px;background:#fff;border-left:3px solid #d32f2f;border-radius:4px;">
          <strong>${p.title}:</strong> ${p.desc}
        </div>`;
      });
    } else if (tabName === 'causes') {
      contentDiv.innerHTML = '<h4>🏭 Sources of Air Pollution</h4>';
      pollutionAwarenessData.causes.forEach(c => {
        contentDiv.innerHTML += `<div style="margin:10px 0;padding:8px;background:#fff;border-left:3px solid #ff9800;border-radius:4px;">
          <strong>${c.title}:</strong> ${c.desc}
        </div>`;
      });
    } else if (tabName === 'precautions') {
      contentDiv.innerHTML = '<h4>🛡️ Precautions & Safety Measures</h4>';
      pollutionAwarenessData.precautions.forEach(p => {
        contentDiv.innerHTML += `<div style="margin:10px 0;padding:8px;background:#fff;border-left:3px solid #28a745;border-radius:4px;">
          <strong>${p.title}:</strong> ${p.desc}
        </div>`;
      });
    } else if (tabName === 'articles') {
      contentDiv.innerHTML = '<h4>📚 Educational Articles & Resources</h4>';
      pollutionAwarenessData.articles.forEach(a => {
        contentDiv.innerHTML += `<a href="${a.url}" target="_blank" rel="noopener noreferrer" class="article-link">📖 ${a.title}</a>`;
      });
    } else if (tabName === 'alerts') {
      const alert = healthAlertData[currentAQI] || healthAlertData[1];
      contentDiv.innerHTML = `<h4 style="color:${alert.color};">🚨 Health Alert: ${alert.level}</h4>`;
      contentDiv.innerHTML += `<div class="health-alert-box" style="border-left-color:${alert.color};background:${alert.color}22;">
        <strong>Mask Recommendation:</strong> ${alert.maskAdvice}
      </div>`;
      contentDiv.innerHTML += `<div class="health-alert-box" style="border-left-color:${alert.color};background:${alert.color}22;">
        <strong>Daily Activities:</strong> ${alert.activities}
      </div>`;
      if (alert.safetyTools && alert.safetyTools.length > 0) {
        contentDiv.innerHTML += `<h4 style="color:${alert.color};margin-top:12px;">Recommended Safety Tools:</h4>`;
        alert.safetyTools.forEach(tool => {
          contentDiv.innerHTML += `<div class="safety-tool-item">✓ ${tool}</div>`;
        });
      }
    }
  }

  // -----------------------
  // 11. ROUTING FUNCTIONS
  // -----------------------
  async function planRoute() {
    const start = startInput.value.trim();
    const end = endInput.value.trim();
    if (!start || !end) {
      alert("Please enter both start and destination locations.");
      return;
    }

    if (routeResultDiv) {
      routeResultDiv.style.display = 'block';
      routeResultDiv.className = '';
      routeResultDiv.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Finding routes...';
    }
    routeLayers.clearLayers();

    try {
      const geocodeUrl = (query) =>
        `https://api.tomtom.com/search/2/geocode/${encodeURIComponent(query)}.json?key=${TOMTOM_KEY}`;
      const [startData, endData] = await Promise.all([
        fetch(geocodeUrl(start)).then(res => res.json()),
        fetch(geocodeUrl(end)).then(res => res.json())
      ]);

      if (!startData.results || startData.results.length === 0) throw new Error(`Start location not found: "${start}"`);
      if (!endData.results || endData.results.length === 0) throw new Error(`Destination not found: "${end}"`);

      const startPos = startData.results[0].position;
      const endPos = endData.results[0].position;

      if (startMarker) routeLayers.removeLayer(startMarker);
      if (endMarker) routeLayers.removeLayer(endMarker);
      startMarker = L.marker([startPos.lat, startPos.lon]).addTo(routeLayers).bindPopup(`<b>Start</b><br>${start}`);
      endMarker = L.marker([endPos.lat, endPos.lon]).addTo(routeLayers).bindPopup(`<b>Destination</b><br>${end}`);

      routeResultDiv.innerHTML = `<div style="margin-bottom:6px"><strong>From:</strong> ${start}   <strong>To:</strong> ${end}</div>`;

      const modesInfo = await getDurationsForModes(startPos, endPos);
      const modesEl = document.createElement('div');
      modesEl.style.marginBottom = '8px';
      modesEl.innerHTML = '<strong>Estimated travel times</strong>';
      const ul = document.createElement('ul');
      ul.style.listStyle = 'none';
      ul.style.padding = '0';
      ul.style.margin = '6px 0 0 0';
      for (const m of modesInfo) {
        const li = document.createElement('li');
        li.style.margin = '6px 0';
        const mins = m.duration ? Math.round(m.duration / 60) : '-';
        const km = m.distance ? (m.distance / 1000).toFixed(1) : '-';
        li.innerHTML = `${m.title}: <strong>${mins} min</strong> (${km} km) `;
        const navBtn = document.createElement('button');
        navBtn.type = 'button';
        navBtn.textContent = 'Navigate';
        navBtn.style.marginLeft = '8px';
        navBtn.addEventListener('click', () => {
          const gmMode = m.googleMode; 
          const origin = `${startPos.lat},${startPos.lon}`;
          const destination = `${endPos.lat},${endPos.lon}`;
          const url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=${gmMode}`;
          window.open(url, '_blank');
        });
        li.appendChild(navBtn);
        ul.appendChild(li);
      }
      modesEl.appendChild(ul);
      routeResultDiv.appendChild(modesEl);

      const tomtomUrl = `https://api.tomtom.com/routing/1/calculateRoute/${startPos.lon},${startPos.lat}:${endPos.lon},${endPos.lat}/json?routeType=fastest&alternatives=3&key=${TOMTOM_KEY}`;

      let routesData;
      try {
        const tomtomRes = await fetch(tomtomUrl);
        routesData = await tomtomRes.json();
        if (!routesData.routes || routesData.routes.length === 0) throw new Error("No routes from TomTom");
      } catch {
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${startPos.lon},${startPos.lat};${endPos.lon},${endPos.lat}?overview=full&geometries=geojson&alternatives=true`;
        const osrmRes = await fetch(osrmUrl);
        const osrmData = await osrmRes.json();
        if (!osrmData.routes || osrmData.routes.length === 0) throw new Error("No routes via OSRM");
        routesData = {
          routes: osrmData.routes.map(r => ({
            summary: { travelTimeInSeconds: r.duration, lengthInMeters: r.distance },
            legs: [{ points: r.geometry.coordinates.map(c => ({ latitude: c[1], longitude: c[0] })) }]
          }))
        };
      }

      let safeRouteExists = false;
      let rainyRouteExists = false;

      for (const route of routesData.routes) {
        const coordinates = route.legs[0].points.map(p => [p.latitude, p.longitude]);
        const isRainy = await checkWeatherAlongRoute(coordinates);
        if (isRainy) {
          rainyRouteExists = true;
          drawRoute(coordinates, true, route.summary.travelTimeInSeconds, route.summary.lengthInMeters); 
        } else {
          safeRouteExists = true;
          drawRoute(coordinates, false, route.summary.travelTimeInSeconds, route.summary.lengthInMeters); 
        }
      }

      for (const route of routesData.routes) {
        const coordinates = route.legs[0].points.map(p => [p.latitude, p.longitude]);
        const aqiInfo = await checkAQIAlongRoute(coordinates);
        displayRouteAQI(aqiInfo);
        break; 
      }

      if (rainyRouteExists && safeRouteExists) {
        routeResultDiv.className = 'mixed';
        routeResultDiv.innerHTML = '<i class="fa-solid fa-cloud-sun-rain"></i> Mixed weather! <span style="color:blue">Blue</span> routes are clear, <span style="color:red">red</span> routes have rain.';
        alert("Rain detected on some routes. Please carry an umbrella or raincoat and drive safely!");
      } else if (rainyRouteExists) {
        routeResultDiv.className = 'rainy';
        routeResultDiv.innerHTML = '<i class="fa-solid fa-cloud-showers-heavy"></i> Rain detected on all routes. Drive safely!';
        alert("Rain detected on all routes. Please carry an umbrella or raincoat and drive safely!");
      } else {
        routeResultDiv.className = 'safe';
        routeResultDiv.innerHTML = '<i class="fa-solid fa-sun"></i> All routes look clear!';
      }

      map.fitBounds(L.featureGroup(routeLayers.getLayers()).getBounds().pad(0.1));

    } catch (error) {
      console.error("Routing Error:", error);
      if (routeResultDiv) {
        routeResultDiv.className = 'rainy';
        routeResultDiv.innerHTML = `<i class="fa-solid fa-exclamation-triangle"></i> Error: ${error.message}`;
      }
    }
  }

  async function getDurationsForModes(startPos, endPos) {
    const profiles = [
      { profile: 'driving', title: 'Driving', googleMode: 'driving' },
      { profile: 'bike', title: 'Bicycling', googleMode: 'bicycling' },
      { profile: 'foot', title: 'Walking', googleMode: 'walking' }
    ];
    const promises = profiles.map(async p => {
      try {
        const url = `https://router.project-osrm.org/route/v1/${p.profile}/${startPos.lon},${startPos.lat};${endPos.lon},${endPos.lat}?overview=false`;
        const res = await fetch(url);
        const data = await res.json();
        if (data && data.routes && data.routes[0]) {
          return { profile: p.profile, title: p.title, duration: data.routes[0].duration, distance: data.routes[0].distance, googleMode: p.googleMode };
        }
      } catch (e) { }
      return { profile: p.profile, title: p.title, duration: null, distance: null, googleMode: p.googleMode };
    });
    return Promise.all(promises);
  }

  async function checkWeatherAlongRoute(coordinates) {
    const promises = [];
    const numPoints = Math.min(coordinates.length, 5);
    const step = Math.floor(coordinates.length / (numPoints > 1 ? numPoints - 1 : 1));

    for (let i = 0; i < coordinates.length; i += step) {
      const [lat, lon] = coordinates[i];
      promises.push(fetch(`${weatherUrl}&lat=${lat}&lon=${lon}`).then(res => res.json()));
    }

    const results = await Promise.all(promises);
    return results.some(data => data.weather && ["Rain", "Thunderstorm", "Drizzle", "Snow"].includes(data.weather[0].main));
  }

  function drawRoute(coordinates, isRainy, duration, distance) {
    const color = isRainy ? 'red' : 'blue';
    const routeLine = L.polyline(coordinates, { color, weight: 5, opacity: 0.7 }).addTo(routeLayers);
    const durationMins = Math.round(duration / 60);
    const distanceKm = (distance / 1000).toFixed(1);
    routeLine.bindPopup(`<b>${isRainy ? 'Rain Detected' : 'Route Clear'}</b><br>${durationMins} minutes (${distanceKm} km)`);
  }

  // -----------------------
  // 12. AI CHATBOX INTEGRATION
  // -----------------------
  
  const aiBtn = document.getElementById('ai-assistant-btn');
  const aiPanel = document.getElementById('ai-panel');
  const aiMessages = document.getElementById('ai-messages');
  const aiInput = document.getElementById('ai-input');
  const aiSend = document.getElementById('ai-send');
  const aiMic = document.getElementById('ai-mic');

  // Toggle Chat
  if (aiBtn) {
    aiBtn.addEventListener('click', () => {
      if (!aiPanel) return;
      const isHidden = aiPanel.style.display === 'none';
      aiPanel.style.display = isHidden ? 'flex' : 'none';
      if (isHidden) aiInput?.focus();
    });
  }

  // Message Handling
  function pushAiUserMessage(text) {
    if (!aiMessages) return;
    const el = document.createElement('div');
    el.className = 'ai-msg-user';
    el.innerText = text;
    aiMessages.appendChild(el);
    aiMessages.scrollTop = aiMessages.scrollHeight;
  }

  function pushAiBotMessage(text) {
    if (!aiMessages) return;
    const el = document.createElement('div');
    el.className = 'ai-msg-bot';
    el.innerHTML = text;
    aiMessages.appendChild(el);
    aiMessages.scrollTop = aiMessages.scrollHeight;
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    const msg = new SpeechSynthesisUtterance(text.replace(/<[^>]*>?/gm, '')); // Strip HTML for voice
    msg.lang = 'en-IN';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(msg);
  }

  // AI Voice Recognition
  if (aiMic && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const aiRecognition = new SpeechRecognition();
    aiRecognition.lang = 'en-IN';
    aiRecognition.continuous = false;
    
    aiMic.addEventListener('click', () => {
      aiMic.style.color = 'red';
      aiRecognition.start();
    });

    aiRecognition.onresult = (event) => {
      const txt = event.results[0][0].transcript;
      pushAiUserMessage(txt);
      processCommand(txt);
      aiMic.style.color = '';
    };
    aiRecognition.onend = () => { aiMic.style.color = ''; };
  }

  if (aiSend) {
    aiSend.addEventListener('click', () => {
      const txt = aiInput.value.trim();
      if (!txt) return;
      pushAiUserMessage(txt);
      aiInput.value = '';
      processCommand(txt);
    });
    aiInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') aiSend.click(); });
  }

  // --- THE FIXED BRAIN LOGIC ---
  function processCommand(raw) {
    if (!raw) return;
    const txt = raw.toLowerCase().trim();

    // 1. GREETINGS
    if (txt === 'hello' || txt === 'hi' || txt === 'help') {
      pushAiBotMessage("Hello! Ask: 'Weather in Mumbai', 'Route from Delhi to Agra', 'Will it rain?', or 'How is the AQI?'");
      return;
    }

    // 2. ROUTE COMMANDS (Restored!)
    if (txt.includes('route') || txt.includes('navigate') || txt.includes('go to')) {
      if (txt.includes(' to ')) {
         let parts = txt.split(' to ');
         let dest = parts[1].trim();
         let origin = "";
         
         if (txt.includes('from')) {
             origin = txt.split('from')[1].split('to')[0].trim();
         } else {
             // If "Navigate to Agra", use current start input or ask user
             if (startInput.value) { origin = startInput.value; } 
             else { pushAiBotMessage(`Where are you starting from? (Say 'Route from [Start] to ${dest}')`); return; }
         }

         startInput.value = origin;
         endInput.value = dest;
         pushAiBotMessage(`🚗 Planning route from ${origin} to ${dest}...`);
         planRoute();
         return;
      }
    }

    // 3. AQI / POLLUTION
    if (txt.includes('aqi') || txt.includes('pollution') || txt.includes('air quality')) {
        if (!aiAqiData) { pushAiBotMessage("Search for a city first."); return; }
        const val = aiAqiData.main.aqi; 
        let status = val === 1 ? "Good 🟢" : val === 2 ? "Fair 🟡" : val === 3 ? "Moderate 🟠" : val === 4 ? "Poor 🔴" : "Very Poor 🟣";
        pushAiBotMessage(`The AQI is ${val}/5 (${status}).`);
        speak(`The AQI is ${status}.`);
        return;
    }

    // 4. RAIN CHECK (Typo tolerant)
    if (txt.includes('rain') || txt.includes('forecast')) {
        if (!aiForecastData) { pushAiBotMessage("Search for a city first."); return; }
        const rainyDays = aiForecastData.filter(d => d.desc.toLowerCase().includes('rain'));
        if (rainyDays.length > 0) {
            const when = new Date(rainyDays[0].date).toLocaleDateString(undefined, {weekday:'long'});
            pushAiBotMessage(`🌧️ Yes, rain expected on ${when} (${rainyDays[0].desc}).`);
        } else {
            pushAiBotMessage("☀️ No rain expected in the next 5 days.");
        }
        return;
    }

    // 5. UMBRELLA ADVICE
    if (txt.includes('umbrella') || txt.includes('raincoat')) {
        if (!aiWeatherData) { pushAiBotMessage("Search for a city first."); return; }
        const currentMain = aiWeatherData.weather[0].main.toLowerCase();
        const nextRain = aiForecastData ? aiForecastData.find(d => d.desc.toLowerCase().includes('rain')) : null;

        if (currentMain.includes('rain')) pushAiBotMessage("☔ Yes, it's raining now!");
        else if (nextRain) pushAiBotMessage(`☁️ Not now, but keep one for ${new Date(nextRain.date).toLocaleDateString(undefined, {weekday:'long'})}.`);
        else pushAiBotMessage("😎 No umbrella needed.");
        return;
    }

    // 6. GENERAL WEATHER
    if (txt.includes('weather')) {
        const city = txt.replace('weather', '').replace('in', '').replace('check', '').trim();
        if(city) { 
            pushAiBotMessage(`🔍 Checking weather for ${city}...`);
            valueSearch.value = city; 
            searchWeather(city); 
        } else { pushAiBotMessage("Which city?"); }
        return;
    }
    
    // 7. MAP CONTROLS
    if (txt.includes('dark mode')) { document.body.style.filter = "invert(1) hue-rotate(180deg)"; pushAiBotMessage("Dark Mode On"); return; }
    if (txt.includes('light mode')) { document.body.style.filter = "none"; pushAiBotMessage("Light Mode On"); return; }
    if (txt.includes('zoom in')) { map.zoomIn(); pushAiBotMessage("Zooming in."); return; }
    if (txt.includes('zoom out')) { map.zoomOut(); pushAiBotMessage("Zooming out."); return; }

    // Fallback
    pushAiBotMessage("I didn't understand. Ask: 'Will it rain?', 'Weather in [City]', or 'Route from [A] to [B]'.");
  }

  // -----------------------
  // 13. INITIAL LOAD
  // -----------------------
  renderHistory();
  searchWeather('Ghaziabad');

});