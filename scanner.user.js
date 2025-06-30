// ==UserScript==
// @name         Waze Scan Closures
// @namespace    https://github.com/WazeDev/waze-scan-closures
// @version      0.0.16
// @description  Passively scan for road closures and get segment/primaryStreet/city/country details.
// @author       Gavin Canon-Phratsachack (https://github.com/gncnpk)
// @match        https://beta.waze.com/*editor*
// @match        https://www.waze.com/*editor*
// @exclude      https://www.waze.com/*user/*editor/*
// @exclude      https://www.waze.com/discuss/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=waze.com
// @license      MIT
// @contributionURL https://github.com/WazeDev/Thank-The-Authors
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      wsc.gc-p.zip
// ==/UserScript==

(function() {
    'use strict';
    unsafeWindow.SDK_INITIALIZED.then(init);
    let sdk;
    let userReportedClosures = [];
    let trackedClosures = [];
    let wazeEditorName;
    let url = localStorage.getItem("waze-scan-closures-url") || "https://wsc.gc-p.zip";
    let endpoints = {
        "TRACKED_CLOSURES": `${url}/trackedClosures`,
        "UPLOAD_CLOSURES": `${url}/uploadClosures`
    }

    async function init() {
        sdk = unsafeWindow.getWmeSdk({
            scriptId: 'wme-scan-closures',
            scriptName: 'Waze Scan Closures'
        });
        while (sdk.State.getUserInfo() === null) {
            console.log("Waze Scan Closures: Waiting for user to be logged in...");
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        wazeEditorName = sdk.State.getUserInfo().userName;
        console.log(`Waze Scan Closures: Logged in as ${wazeEditorName}`);
        getTrackedClosures();
        sdk.Events.trackDataModelEvents({
            dataModelName: "roadClosures"
        });
        sdk.Events.on({
            eventName: "wme-data-model-objects-added",
            eventHandler: updateRoadClosures
        });
        userReportedClosures = filterUserClosures(sdk.DataModel.RoadClosures.getAll());
        sdk.Sidebar.registerScriptTab().then(async (res) => {
            res.tabLabel.innerText = "WSC";
            // Create text area for inputting url, update variable when value changes
            res.tabPane.innerHTML = `
                <div>
                    <label for="WSCApiUrl">API URL:</label>
                    <input type="text" id="WSCApiUrl" value="${url}" style="width: 100%;" />
                </div>
            `;
            res.tabPane.querySelector("#WSCApiUrl").addEventListener("input", (e) => {
                url = e.target.value;
                localStorage.setItem("waze-scan-closures-url", url);
                endpoints["TRACKED_CLOSURES"] = `${url}/trackedClosures`;
                endpoints["UPLOAD_CLOSURES"] = `${url}/uploadClosures`;
            });
        });
        console.log(`Waze Scan Closures: Initialized!`);
    }

    function getTrackedClosures() {
        if (url === "" || wazeEditorName === undefined || wazeEditorName === null) {
            console.error("Waze Scan Closures: URL not set!");
            return;
        }
        let data = {userName: wazeEditorName, env: sdk.Settings.getRegionCode() }
        let details = {
            method: "POST",
            data: JSON.stringify(data),
            url: endpoints["TRACKED_CLOSURES"],
            headers: {
                "Content-Type": "application/json"
            },
            onload: function(response) {
                let trkRes = JSON.parse(response.responseText);
                console.log(`Waze Scan Closures: Retrieved ${trkRes.length} tracked closures!`);
                trackedClosures = trkRes;
            }
        };
        console.log(`Waze Scan Closures: Retriving tracked closures...`);
        GM_xmlhttpRequest(details);
    }

    function filterUserClosures(closures) {
        return closures.filter(c => {
            if (
                !c.description &&
                c.startDate &&
                c.endDate &&
                !trackedClosures.includes(c.id)
            ) {
                const duration =
                    new Date(c.endDate).getTime() -
                    new Date(c.startDate).getTime();
                const target = 60 * 60 * 1000; // 1 hour in ms
                const margin = 60 * 1000; // 1 minute in ms

                return Math.abs(duration - target) <= margin;
            }
            return false;
        });
    }

    function removeObjectProperties(obj, props) {

        for (var i = 0; i < props.length; i++) {
            if (obj.hasOwnProperty(props[i])) {
                delete obj[props[i]];
            }
        }

    };

    function updateRoadClosures() {
        let currentUserReportedClosures = filterUserClosures(sdk.DataModel.RoadClosures.getAll());
        if (currentUserReportedClosures.length !== 0) {
            userReportedClosures = currentUserReportedClosures;
            console.log(`Waze Scan Closures: Found ${userReportedClosures.length} user reported closures!`)
            userReportedClosures.forEach((i) => {
                let location = []
                // Locally store tracked closures
                trackedClosures.push(i.id)
                if (i.segmentId !== null) i.segment = sdk.DataModel.Segments.getById({
                    segmentId: i.segmentId
                });
                if (i.segment !== undefined && i.segment !== null) {
                    i.roadType = I18n.t("segment.road_types")[i.segment.roadType];
                    i.roadTypeEnum = i.segment.roadType;
                    i.lon = i.segment.geometry.coordinates.reduce((sum, coord) => sum + coord[0], 0) / i.segment.geometry.coordinates.length;
                    i.lat = i.segment.geometry.coordinates.reduce((sum, coord) => sum + coord[1], 0) / i.segment.geometry.coordinates.length;
                    i.primaryStreet = sdk.DataModel.Streets.getById({
                        streetId: i.segment.primaryStreetId
                    });
                }
                if (i.primaryStreet !== undefined && i.primaryStreet !== null) {
                    i.city = sdk.DataModel.Cities.getById({
                        cityId: i.primaryStreet.cityId
                    });
                    location.push(i.primaryStreet.englishName || i.primaryStreet.name);
                }
                if (i.city !== undefined && i.city !== null) {
                    i.state = sdk.DataModel.States.getById({
                        stateId: i.city.stateId
                    });
                    i.country = sdk.DataModel.Countries.getById({
                        countryId: i.city.countryId
                    });
                    location.push(i.city.name);
                }
                if (i.state !== undefined && i.state !== null) {
                    delete i.state.geometry;
                    location.push(i.state.name);
                }
                if (i.country !== undefined && i.country !== null) {
                    removeObjectProperties(i.country, ['restrictionSubscriptions', 'defaultLaneWidthPerRoadType']);
                    location.push(i.country.name);
                }
                i.location = location.join(", ");
                i.createdBy = i.modificationData.createdBy;
                i.createdOn = i.modificationData.createdOn;
                i.isForward ? i.direction = "A➜B" : i.direction = "B➜A";
                removeObjectProperties(i, ['city', 'state', 'country', 'primaryStreet', 'isPermanent', 'description', 'endDate', 'modificationData', 'startDate', 'isForward', 'segment', 'status', 'trafficEventId'])
            });
            let uploadData = {
                //bbox: sdk.Map.getMapExtent(),
                userName: wazeEditorName,
                closures: userReportedClosures
            };
            sendClosures(uploadData);
        } else {
            console.log(`Waze Scan Closures: No new closures found...`)
        }
    }

    function sendClosures(uploadData) {
        if (url === "" || wazeEditorName === undefined || wazeEditorName === null) {
            console.error("Waze Scan Closures: URL not set!");
            return;
        }
        // use GM_xmlhttpRequest(details)
        let details = {
            method: "POST",
            url: endpoints["UPLOAD_CLOSURES"],
            data: JSON.stringify(uploadData),
            headers: {
                "Content-type": "application/json; charset=UTF-8"
            }
        };
        GM_xmlhttpRequest(details);
        getTrackedClosures();
    }
})();
