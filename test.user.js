// ==UserScript==
// @name         Waze Scan Closures
// @namespace    https://github.com/WazeDev/waze-scan-closures
// @version      0.0.1
// @description  try to take over the world!
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
    let url = "";

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
    function filterUserClosures(closures) {
    return closures.filter(c =>
        !c.description &&
        c.startDate &&
        c.endDate &&
        (new Date(c.endDate).getTime() - new Date(c.startDate).getTime()) === 3600000
      );
    }

    function updateRoadClosures() {
        let currentUserReportedClosures = filterUserClosures(sdk.DataModel.RoadClosures.getAll());
        if (userReportedClosures.length !== currentUserReportedClosures.length) {
            userReportedClosures = currentUserReportedClosures;
            console.log(`Waze Scan Closures: Found ${userReportedClosures.length} user reported closures!`)
            console.log(userReportedClosures)
            //sendClosures();
        }
    }

    function sendClosures() {
        let ClosuresReq = fetch(url, {
            method: "POST",
            body: JSON.stringify(roadClosures),
            headers: {
                "Content-type": "application/json; charset=UTF-8"
            }
        });
    }
    // Your code here...
})();
