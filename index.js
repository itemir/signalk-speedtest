/*
 * Copyright 2021 Ilker Temir <ilker@ilkertemir.com>
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const request = require('request');
const speedTest = require('speedtest-net');

const CHECK_POSITION_EVERY_N_MINUTE = 1;
const KEEP_N_POSITIONS = 30;
const MAX_DISTANCE = 0.1;

module.exports = function (app) {
  var plugin = {};
  var positions = [];
  var mainProcess;
  var lastSpeedTestDate;
  var lastSpeedTestPosition;
  var interval;
  var website;
  var equipment;
  var testOnMove;

  plugin.id = 'speedtest';
  plugin.name = 'Internet Speed Test';
  plugin.description = 'Automatically log Internet speeds from moorages';

  function calculateDistance(lat1, lon1, lat2, lon2) {
    if ((lat1 == lat2) && (lon1 == lon2)) {
      return 0;
    }
    else {
      var radlat1 = Math.PI * lat1/180;
      var radlat2 = Math.PI * lat2/180;
      var theta = lon1-lon2;
      var radtheta = Math.PI * theta/180;
      var dist = Math.sin(radlat1) * Math.sin(radlat2) + Math.cos(radlat1) * Math.cos(radlat2) * Math.cos(radtheta);
      if (dist > 1) {
          dist = 1;
      }
      dist = Math.acos(dist);
      dist = dist * 180/Math.PI;
      dist = dist * 60 * 1.1515;
      dist = dist * 0.8684; // Convert to Nautical miles
      return dist;
    }
  }

  function calculateDistanceOfPath(path) {
    if (path.length < 2) {
      return (0);
    }
    let distance = 0;
    for (let i=1;i< path.length;i++) {
      distance = distance + calculateDistance(path[i].latitude, path[i].longitude,
	                                      path[i-1].latitude, path[i-1].longitude);
    }
    return distance;
  }

  function submitDataToServer(data) {
    let httpOptions = {
      uri: 'https://boatersatlas.com/measurements/submit/',
      method: 'POST',
      json: JSON.stringify(data)
    };

    request(httpOptions, function (error, response, body) {
      if (!error && response.statusCode == 200) {
	lastSpeedTestDate = Date.now();
        let position = getKeyValue('navigation.position', 60);
	if (position) {
	  lastSpeedTestPosition = position;
	}
        app.debug('Data successfully submitted');
      } else {
        app.debug('Submission failed');
      }
    });
  }

  function doSpeedTest(position) {
    (async () => {
      try {
	app.debug('Starting speedtest');
        let options = {
	  acceptLicense: true,
	  acceptGdpr: true
	}
	let data = {
	  name: app.getSelfPath('name'),
	  mmsi: app.getSelfPath('mmsi'),
	  website: website,
	  equipment: equipment,
	  position: position,
  	  results: await speedTest(options)
        }
	app.debug(`Submitting data to server`);
	app.debug(JSON.stringify(data));
	let uploadSpeed = Math.round(10*data.results.upload.bandwidth*8/1000/1000)/10;
	let downloadSpeed = Math.round(10*data.results.download.bandwidth*8/1000/1000)/10;
	app.setPluginStatus(`${downloadSpeed} Mbps download, ${uploadSpeed} Mbps upload via ${data.results.isp}`);
	submitDataToServer(data);
      } catch (err) {
	app.debug(`Speedtest Error: ${err.message}`);
      } finally {
        app.debug('Speedtest completed');
      }
    })();
  }

  function getKeyValue(key, maxAge) {
    let data = app.getSelfPath(key);
    if (!data) {
      return null;
    }
    let now = new Date();
    let ts = new Date(data.timestamp);
    let age = (now - ts) / 1000;
    if (age <= maxAge) {
      return data.value
    } else {
      return null;
    }
  }

  plugin.start = function (options, restartPlugin) {
    if ((!options.eula) || (!options.tos) || (!options.privacy) || (!options.gdpr)) {
      app.error('You need to accept the EULA, TOS, Privacy and GDPR policies.');
      return;
    }

    // Keep interval within boundries
    interval = Math.min(options.interval, 84);
    interval = Math.max(interval, 8);
    equipment = options.equipment;
    website = options.website;
    testOnMove = options.testOnMove;

    // Capture a position every minute
    mainProcess = setInterval( () => {
      let position = getKeyValue('navigation.position', 60);
      app.debug(`Position received ${position.latitude}, ${position.longitude}`);
      positions.unshift({latitude: position.latitude, longitude: position.longitude});
      positions = positions.slice(0, KEEP_N_POSITIONS);
      let distance = calculateDistanceOfPath(positions);
      app.debug(`Total distance in last ${positions.length} minutes is ${distance} miles`);
      if ((positions.length >= KEEP_N_POSITIONS) && (distance <= MAX_DISTANCE)) {
	let distanceFromLastSpeedTest = 0;
        if (lastSpeedTestPosition) {
	  distanceFromLastSpeedTest = calculateDistance(position.latitude,
		                        position.longitude,
		  			lastSpeedTestPosition.latitude,
		  			lastSpeedTestPosition.longitude);
	}
	let timeSinceSpeedTest=0;
	if (lastSpeedTestDate) {
	  timeSinceLastSpeedTest = Date.now() - lastSpeedTestDate;
	}
	if (
	    ((testOnMove) && (distanceFromLastSpeedTest >= 1)) ||
	    (!lastSpeedTestDate) || (timeSinceLastSpeedTest > interval * 60 * 60 * 1000)
           ) {
	  // Reset positions
	  positions = [];
	  doSpeedTest(position);
	} else {
	  app.debug(`Not doing a speedtest. ` +
	            `Interval: ${interval} hours / ` +
		    `Time passed: ${timeSinceLastSpeedTest / 60 / 60 / 1000} hours / ` +
		    `Distance Moved ${distanceFromLastSpeedTest} miles` +
		    `Test on Move Enabled: ${testOnMove}`
		    );
	}
      }
    }, CHECK_POSITION_EVERY_N_MINUTE*60*1000);
  };

  plugin.stop = function () {
    clearInterval(mainProcess);
  };

  plugin.schema = {
    type: 'object',
    required: ['eula','tos','privacy','gdpr','interval','testOnMove'],
    properties: {
      eula: {
        type: 'boolean',
        title: 'Accept Speedtest EULA (https://www.speedtest.net/about/eula)',
        default: false
      },
      tos: {
        type: 'boolean',
        title: 'Accept Speedtest Terms of Use (https://www.speedtest.net/about/terms)',
        default: false
      },
      privacy: {
        type: 'boolean',
        title: 'Accept Speedtest Privacy Policy (https://www.speedtest.net/about/privacy)',
        default: false
      },
      gdpr: {
        type: 'boolean',
        title: 'Accept GDPR terms (https://www.speedtest.net/gdpr-dpa)',
        default: false,
      },
      interval: {
        type: 'number',
        title: 'Minimum time between speed tests (between 8-84 hours)',
        default: 48,
      },
      testOnMove: {
        type: 'boolean',
        title: 'Do a speedtest when the vessel moves more than 1 mile, even if minimum time has not passed',
        default: true, 
      },
      website: {
        type: 'string',
        title: 'Website (Optional)'
      },
      equipment: {
        type: 'string',
        title: 'Equipment used for your Internet connection (Optional)'
      },
    }
  };

  return plugin;
};
