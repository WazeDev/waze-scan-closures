// ==UserScript==
// @name         Waze Scan Closures
// @namespace    https://github.com/WazeDev/waze-scan-closures
// @version      0.0.3
// @description  Passively scan for road closures and get segment/primaryStreet/city/country details.
// @author       Gavin Canon-Phratsachack (https://github.com/gncnpk)
// @match        https://beta.waze.com/*editor*
// @match        https://www.waze.com/*editor*
// @exclude      https://www.waze.com/*user/*editor/*
// @exclude      https://www.waze.com/discuss/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=waze.com
// @license      MIT
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    window.SDK_INITIALIZED.then(init);
    let sdk;
    let userReportedClosures = [];
    let trackedClosures = [];
    let url = "";
    let endpoints = {"TRACKED_CLOSURES": `${url}/trackedClosures`, "UPLOAD_CLOSURES": `${url}/uploadClosures`}

    function init() {
        sdk = window.getWmeSdk({
            scriptId: 'wme-scan-closures',
            scriptName: 'Waze Scan Closures'
        });
        sdk.Events.on({
            eventName: "wme-map-data-loaded",
            eventHandler: updateRoadClosures
        })
        userReportedClosures = filterUserClosures(sdk.DataModel.RoadClosures.getAll());
        console.log(`Waze Scan Closures: Initalized!`);
    }
    async function getTrackedClosures() {
         let trkReq = await fetch(endpoints["TRACKED_CLOSURES"]);
         let trkRes = await trkReq.json()
         trackedClosures = trkRes.closures;
    }
    function filterUserClosures(closures) {
    return closures.filter(c =>
        !c.description &&
        c.startDate &&
        c.endDate &&
        (new Date(c.endDate).getTime() - new Date(c.startDate).getTime()) === 3600000 && !trackedClosures.includes(c.id)
      );
    }

    function updateRoadClosures() {
        let currentUserReportedClosures = filterUserClosures(sdk.DataModel.RoadClosures.getAll());
        if (currentUserReportedClosures.length !== 0) {
            userReportedClosures = currentUserReportedClosures;
            console.log(`Waze Scan Closures: Found ${userReportedClosures.length} user reported closures!`)
            userReportedClosures.forEach((i) => {
                let location = []
                // Locally store tracked closures
                trackedClosures.push(i.id)
                if (i.segmentId !== null) i.segment = sdk.DataModel.Segments.getById({segmentId: i.segmentId});
                i.roadType = I18n.t("segment.road_types")[i.segment.roadType];
                i.lon = i.segment.geometry.coordinates.reduce((sum, coord) => sum + coord[0], 0) / i.segment.geometry.coordinates.length;
                i.lat = i.segment.geometry.coordinates.reduce((sum, coord) => sum + coord[1], 0) / i.segment.geometry.coordinates.length;
                if (i.segment !== undefined && i.segment !== null) i.primaryStreet = sdk.DataModel.Streets.getById({ streetId: i.segment.primaryStreetId });
                location.push(i.primaryStreet.englishName || i.primaryStreet.name)
                if (i.primaryStreet !== undefined && i.primaryStreet !== null) i.city = sdk.DataModel.Cities.getById({ cityId: i.primaryStreet.cityId});
                location.push(i.city.name)
                if (i.city !== undefined && i.city !== null) i.state = sdk.DataModel.States.getById({ stateId: i.city.stateId });
                location.push(i.state.name)
                if (i.city !== undefined && i.city !== null) i.country = sdk.DataModel.Countries.getById({ countryId: i.city.countryId });
                location.push(i.country.name)
                i.location = location.join(", ");
                i.isForward ? i.direction = "A➜B" : i.direction = "B➜A"
            });
            console.log(userReportedClosures);
            //sendClosures();
        } else {
            console.log(`Waze Scan Closures: No new closures found...`)
        }
    }

    function sendClosures() {
        let ClosuresReq = fetch(endpoints["UPLOAD_CLOSURES"], {
            method: "POST",
            body: JSON.stringify(userReportedClosures),
            headers: {
                "Content-type": "application/json; charset=UTF-8"
            }
        });
    }
    // Your code here...
})();
