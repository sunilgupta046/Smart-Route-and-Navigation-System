document.addEventListener('DOMContentLoaded', function() {
  const OWM_KEY = '9505fd1df737e20152fbd78cdb289b6a';
  const TOMTOM_KEY = 'YHB95ZB47iFTcDkDqOerQM6sgbsNomKr';
  const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?units=metric&appid=${OWM_KEY}`;
  const forecastUrlBase = `https://api.openweathermap.org/data/2.5/forecast?units=metric&appid=${OWM_KEY}`;
  const aqiUrl = `https://api.openweathermap.org/data/3.0/stations?appid=${OWM_KEY}`;

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
  
  // Track selected route
  let selectedRouteIndex = -1;
  let allRoutes = [];

  const map = L.map('map').setView([28.6738, 77.4458], 10);
  let routeLayers = L.layerGroup().addTo(map);
  let startMarker = null;
  let endMarker = null;
  let selectedRoute = null; // store selected route info

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (valueSearch.value.trim() !== '') searchWeather(valueSearch.value.trim());
  });

  routeButton.addEventListener('click', planRoute);

  // Allow pressing Enter while focused in start/end inputs to trigger route search
  if (startInput) {
    startInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // If destination already entered, run route search immediately
        if (endInput && endInput.value && endInput.value.trim() !== '') {
          planRoute();
          return;
        }
        // Otherwise move focus to destination input for quick entry
        if (endInput) endInput.focus();
      }
    });
  }
  if (endInput) {
    endInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        planRoute();
      }
    });
  }

  // load and render recent history
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
    const list = loadHistory();
    historyList.innerHTML = '';
    for (const item of list) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = item;
      btn.style.padding = '6px 8px';
      btn.style.border = '1px solid #ccc';
      btn.style.background = '#fff';
      btn.addEventListener('click', () => {
        valueSearch.value = item;
        searchWeather(item);
      });
      li.appendChild(btn);
      historyList.appendChild(li);
    }
  }

  // Voice Assistant
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
      // Remove trailing dot if present
      if (transcript.endsWith('.')) {
        transcript = transcript.slice(0, -1);
      }
      valueSearch.value = transcript;
      searchWeather(transcript);
    };
    recognition.onerror = function() {
      alert('Voice recognition failed. Please try again.');
    };
    recognition.onend = function() {
      voiceBtn.disabled = false;
      voiceBtn.querySelector('i').classList.remove('fa-spin');
    };
  }

  if (useMyLocationBtn && navigator.geolocation) {
    useMyLocationBtn.addEventListener('click', function() {
      useMyLocationBtn.disabled = true;
      useMyLocationBtn.innerText = "Getting location...";
      navigator.geolocation.getCurrentPosition(
        async function(position) {
          const lat = position.coords.latitude;
          const lon = position.coords.longitude;
          // Reverse geocode to get a place name for the input (optional)
          const res = await fetch(`https://api.tomtom.com/search/2/reverseGeocode/${lat},${lon}.json?key=${TOMTOM_KEY}`);
          const data = await res.json();
          let address = `${lat},${lon}`;
          if (data.addresses && data.addresses.length > 0) {
            address = data.addresses[0].address.freeformAddress;
          }
          startInput.value = address;
          useMyLocationBtn.innerText = "Use My Location";
          useMyLocationBtn.disabled = false;
          // Optionally, auto-plan route if destination is filled
          if (endInput.value.trim() !== '') {
            planRoute();
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

  // fetch 5-day forecast and return array of {date,temp,icon,desc}
  async function fetchForecast(city) {
     try {
       const res = await fetch(`${forecastUrlBase}&q=${encodeURIComponent(city)}`);
       const data = await res.json();
       if (!data || (data.cod && data.cod !== "200" && data.cod !== 200)) return null;
       // Group by date and pick entry closest to 12:00 for each date
       const byDate = {};
       (data.list || []).forEach(item => {
         const date = item.dt_txt.split(' ')[0];
         (byDate[date] = byDate[date] || []).push(item);
       });
       const dates = Object.keys(byDate).slice(0,5);
       const result = dates.map(date => {
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
       return result;
     } catch (e) {
       return null;
     }
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

   // Fetch previous 5 days using One Call Time Machine (requires lat/lon)
   async function fetchPastFiveDays(lat, lon) {
     try {
       const now = Math.floor(Date.now() / 1000);
       const daySeconds = 24 * 60 * 60;
       const results = [];
       // Fetch 1..5 days ago
       for (let i = 5; i >= 1; i--) {
         const dt = now - i * daySeconds;
         const url = `https://api.openweathermap.org/data/2.5/onecall/timemachine?lat=${lat}&lon=${lon}&dt=${dt}&units=metric&appid=${OWM_KEY}`;
         const res = await fetch(url);
         if (!res.ok) continue;
         const data = await res.json();
         if (!data || !data.hourly || data.hourly.length === 0) continue;
         // pick hour closest to 12:00 local (12:00 UTC approximation)
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
     } catch (e) {
       return null;
     }
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
 
  async function planRoute() {
    const start = startInput.value.trim();
    const end = endInput.value.trim();
    if (!start || !end) {
      alert("Please enter both start and destination locations.");
      return;
    }

    routeResultDiv.style.display = 'block';
    routeResultDiv.className = '';
    routeResultDiv.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Finding routes...';
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

      // show source/destination markers
      if (startMarker) routeLayers.removeLayer(startMarker);
      if (endMarker) routeLayers.removeLayer(endMarker);
      startMarker = L.marker([startPos.lat, startPos.lon]).addTo(routeLayers).bindPopup(`<b>Start</b><br>${start}`);
      endMarker = L.marker([endPos.lat, endPos.lon]).addTo(routeLayers).bindPopup(`<b>Destination</b><br>${end}`);

      // show quick summary of source/destination
      routeResultDiv.innerHTML = `<div style="margin-bottom:6px"><strong>From:</strong> ${start} &nbsp; <strong>To:</strong> ${end}</div>`;

      // calculate ETAs for driving / biking / walking
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
          // open Google Maps directions for this mode
          const gmMode = m.googleMode; // driving, bicycling, walking
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

      // TomTom with alternatives
      const tomtomUrl = `https://api.tomtom.com/routing/1/calculateRoute/${startPos.lon},${startPos.lat}:${endPos.lon},${endPos.lat}/json?routeType=fastest&alternatives=3&key=${TOMTOM_KEY}`;

      let routesData;
      try {
        const tomtomRes = await fetch(tomtomUrl);
        routesData = await tomtomRes.json();
        if (!routesData.routes || routesData.routes.length === 0) throw new Error("No routes from TomTom");
      } catch {
        // OSRM fallback with multiple routes
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
      allRoutes = [];

      // Analyze all routes and check for rain
      for (let idx = 0; idx < routesData.routes.length; idx++) {
        const route = routesData.routes[idx];
        const coordinates = route.legs[0].points.map(p => [p.latitude, p.longitude]);
        const isRainy = await checkWeatherAlongRoute(coordinates);
        const duration = route.summary.travelTimeInSeconds;
        const distance = route.summary.lengthInMeters;
        
        allRoutes.push({
          index: idx,
          coordinates,
          isRainy,
          duration,
          distance,
          title: `Route ${idx + 1}`
        });
        
        if (isRainy) {
          rainyRouteExists = true;
        } else {
          safeRouteExists = true;
        }
      }

      // Draw all routes on map
      allRoutes.forEach((route, idx) => {
        drawRoute(route.coordinates, route.isRainy, route.duration, route.distance);
      });

      // Create route selection UI
      const routeSelectDiv = document.createElement('div');
      routeSelectDiv.style.marginTop = '12px';
      routeSelectDiv.innerHTML = '<strong>Available Routes:</strong><br>';
      
      for (let i = 0; i < allRoutes.length; i++) {
        const route = allRoutes[i];
        const durationMins = Math.round(route.duration / 60);
        const distanceKm = (route.distance / 1000).toFixed(1);
        const weatherIcon = route.isRainy ? '🌧️' : '☀️';
        const weatherText = route.isRainy ? 'Rainy' : 'Clear';
        
        const routeBtn = document.createElement('button');
        routeBtn.type = 'button';
        routeBtn.innerHTML = `${weatherIcon} ${route.title} - ${durationMins} min (${distanceKm} km) - ${weatherText}`;
        routeBtn.style.display = 'block';
        routeBtn.style.width = '100%';
        routeBtn.style.padding = '8px';
        routeBtn.style.margin = '4px 0';
        routeBtn.style.background = route.isRainy ? '#ffe0e0' : '#e0f7ff';
        routeBtn.style.border = '2px solid ' + (route.isRainy ? '#ff6b6b' : '#1e90ff');
        routeBtn.style.borderRadius = '4px';
        routeBtn.style.cursor = 'pointer';
        routeBtn.style.fontWeight = '500';
        
        routeBtn.addEventListener('click', () => selectRoute(i, startPos, endPos));
        routeSelectDiv.appendChild(routeBtn);
      }

      // Check AQI along first route
      if (allRoutes.length > 0) {
        const coordinates = allRoutes[0].coordinates;
        const aqiInfo = await checkAQIAlongRoute(coordinates);
        displayRouteAQI(aqiInfo);
      }

      // Update summary
      let summaryHtml = `<div style="margin-bottom:12px"><strong>From:</strong> ${start} &nbsp; <strong>To:</strong> ${end}</div>`;
      if (rainyRouteExists && safeRouteExists) {
        summaryHtml += '<i class="fa-solid fa-cloud-sun-rain"></i> Mixed weather! <span style="color:blue">Blue</span> routes are clear, <span style="color:red">red</span> routes have rain.';
      } else if (rainyRouteExists) {
        summaryHtml += '<i class="fa-solid fa-cloud-showers-heavy"></i> Rain detected on all routes. Drive safely!';
      } else {
        summaryHtml += '<i class="fa-solid fa-sun"></i> All routes look clear!';
      }
      
      routeResultDiv.innerHTML = summaryHtml;
      routeResultDiv.appendChild(routeSelectDiv);
      
      if (rainyRouteExists && safeRouteExists) {
        routeResultDiv.className = 'mixed';
        alert("Rain detected on some routes. Please carry an umbrella or raincoat and drive safely!");
      } else if (rainyRouteExists) {
        routeResultDiv.className = 'rainy';
        alert("Rain detected on all routes. Please carry an umbrella or raincoat and drive safely!");
      } else {
        routeResultDiv.className = 'safe';
      }

      map.fitBounds(L.featureGroup(routeLayers.getLayers()).getBounds().pad(0.1));

    } catch (error) {
      console.error("Routing Error:", error);
      routeResultDiv.className = 'rainy';
      routeResultDiv.innerHTML = `<i class="fa-solid fa-exclamation-triangle"></i> Error: ${error.message}`;
    }
  }

  // Query OSRM for multiple profiles and return durations/distances
  async function getDurationsForModes(startPos, endPos) {
    // startPos/endPos: {lat, lon}
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
      } catch (e) {
        // ignore
      }
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

  function selectRoute(routeIndex, startPos, endPos) {
    selectedRouteIndex = routeIndex;
    const route = allRoutes[routeIndex];
    
    // Highlight selected route
    routeLayers.clearLayers();
    if (startMarker) startMarker = L.marker([startPos.lat, startPos.lon]).addTo(routeLayers).bindPopup(`<b>Start</b>`);
    if (endMarker) endMarker = L.marker([endPos.lat, endPos.lon]).addTo(routeLayers).bindPopup(`<b>Destination</b>`);
    
    // Draw selected route with thicker line
    const color = route.isRainy ? 'red' : 'blue';
    const routeLine = L.polyline(route.coordinates, { color, weight: 8, opacity: 0.9 }).addTo(routeLayers);
    const durationMins = Math.round(route.duration / 60);
    const distanceKm = (route.distance / 1000).toFixed(1);
    const weatherText = route.isRainy ? 'Rain Detected' : 'Route Clear';
    routeLine.bindPopup(`<b>${weatherText}</b><br>${durationMins} minutes (${distanceKm} km)`).openPopup();
    
    // Update AQI for selected route
    checkAQIAlongRoute(route.coordinates).then(aqiInfo => {
      displayRouteAQI(aqiInfo);
    });
    
    map.fitBounds(routeLine.getBounds().pad(0.1));
  }

  // Update temperature display to always show 2 digits
  function searchWeather(cityName) {
    fetch(`${weatherUrl}&q=${encodeURIComponent(cityName)}`)
      .then(res => res.json())
      .then(async data => {
        const errorEl = document.getElementById('error-message');
        if (data.cod !== 200) {
          errorEl.style.display = 'block';
          errorEl.innerText = data.message || "City not found!";
          return;
        }
        errorEl.style.display = 'none';
        document.querySelector('.result .name figcaption').innerText = data.name;
        document.querySelector('.result .name img').src = `https://flagsapi.com/${data.sys.country}/shiny/32.png`;
        document.querySelector('.result .temperature img').src = `https://openweathermap.org/img/wn/${data.weather[0].icon}@4x.png`;
        // Show temperature as 2 digits
        document.querySelector('.result .temperature span').innerText = data.main.temp.toFixed(2).padStart(5, '0');
        document.querySelector('.result .description').innerText = data.weather[0].description;
        document.getElementById('clouds').innerText = data.clouds.all;
        document.getElementById('humidity').innerText = data.main.humidity;
        document.getElementById('pressure').innerText = data.main.pressure;
        // save search and fetch 5-day forecast
        saveSearch(cityName);
        const days = await fetchForecast(cityName);
        renderForecast(days);
        // fetch past 5 days using coordinates from current weather
        const lat = data.coord && data.coord.lat;
        const lon = data.coord && data.coord.lon;
        if (lat != null && lon != null) {
          const past = await fetchPastFiveDays(lat, lon);
          renderPastForecast(past);
          // Fetch and display AQI
          const aqiData = await fetchAQI(lat, lon);
          displayAQI(aqiData);
        } else {
          // try geocoding fallback or hide past
          renderPastForecast(null);
        }
      });
  }

  // AQI Helper Functions
  async function fetchAQI(lat, lon) {
    try {
      const url = `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${OWM_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data && data.list && data.list[0]) {
        return data.list[0];
      }
      return null;
    } catch (e) {
      console.error('AQI fetch error:', e);
      return null;
    }
  }

  function getAQILevel(aqi) {
    // AQI Scale: 1=Good, 2=Fair, 3=Moderate, 4=Poor, 5=Very Poor
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
    
    // Display AQI level and value
    document.getElementById('aqi-level').innerHTML = `${info.icon} ${info.level}`;
    document.getElementById('aqi-value').innerText = `AQI Level: ${aqi}/5`;
    
    // Main pollutants
    const pollutants = [];
    if (components.pm25) pollutants.push(`PM2.5: ${components.pm25.toFixed(1)} µg/m³`);
    if (components.pm10) pollutants.push(`PM10: ${components.pm10.toFixed(1)} µg/m³`);
    if (components.o3) pollutants.push(`O₃: ${components.o3.toFixed(1)} ppb`);
    if (components.no2) pollutants.push(`NO₂: ${components.no2.toFixed(1)} ppb`);
    document.getElementById('aqi-main-pollutant').innerText = pollutants.join(' | ');
    
    // Health alert
    const alertEl = document.getElementById('aqi-health-alert');
    alertEl.className = info.class;
    alertEl.innerHTML = `<strong>${info.level.toUpperCase()}</strong><br>${info.message}`;
    
    // Vehicle recommendations
    const vehicles = getVehicleRecommendations(aqi);
    vehicleRecDiv.innerHTML = '';
    vehicles.forEach(v => {
      const div = document.createElement('div');
      div.className = 'vehicle-item';
      div.innerHTML = `<strong>${v.vehicle}</strong><br>${v.recommendation}`;
      vehicleRecDiv.appendChild(div);
    });
    
    // Indoor AQI advice
    indoorAqiDiv.innerHTML = `<strong>Current AQI Level:</strong> ${info.level}<br>`;
    if (aqi >= 3) {
      indoorAqiDiv.innerHTML += '⚠️ <strong>Recommended:</strong> Keep windows closed. Use air purifier if available.';
      purifierDiv.innerHTML = getPurifierSuggestions(aqi);
    } else {
      indoorAqiDiv.innerHTML += '✓ <strong>Good air quality:</strong> You can safely open windows.';
      purifierDiv.innerHTML = '<div style="color: #28a745;">No air purifier needed at this time.</div>';
    }
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
    routeAqiDiv.innerHTML = '';
    if (!aqiInfo) return;
    
    const info = getAQILevel(Math.round(aqiInfo.avgAqi));
    const div = document.createElement('div');
    div.className = 'route-aqi-item';
    div.innerHTML = `<strong>Average AQI along route:</strong> ${info.level} (${aqiInfo.avgAqi}/5)<br>
      <small>${info.message}</small>`;
    routeAqiDiv.appendChild(div);
  }

  // initial setup
  renderHistory();

  searchWeather('Ghaziabad');

});

