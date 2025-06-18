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
     window.SDK_INITIALIZED.then(initialize);
    let sdk;
    function initalize() {
    sdk = window.getWmeSdk({
        scriptId: 'wme-scan-closures',
        scriptName: 'Waze Scan Closures'
    });
    // set zoom level to 14
    sdk.Map.setZoomLevel({zoomLevel: 14})
    }
    function scan() {
    // wait till ready
    //sdk.State.isReady();
    }
    // Your code here...
})();
