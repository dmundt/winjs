// Copyright (c) Microsoft Corporation.  All Rights Reserved. Licensed under the MIT License. See License.txt in the project root for license information.
define(["require", "exports", "./Core/_Global", "./Core/_Base", "./Core/_BaseUtils", "./Utilities/_ElementUtilities", "./Core/_Events", "./ControlProcessor/_OptionsParser"], function (require, exports, _Global, _Base, _BaseUtils, _ElementUtilities, _Events, _OptionsParser) {
    "use strict";
    var Keys = _ElementUtilities.Key;
    var AttributeNames = {
        focusOverride: "data-win-xyfocus",
        focusOverrideLegacy: "data-win-focus"
    };
    var ClassNames = {
        focusable: "win-focusable",
        suspended: "win-xyfocus-suspended",
        toggleMode: "win-xyfocus-togglemode",
        toggleModeActive: "win-xyfocus-togglemode-active",
        xboxPlatform: "win-xbox",
    };
    var CrossDomainMessageConstants = {
        messageDataProperty: "msWinJSXYFocusControlMessage",
        register: "register",
        unregister: "unregister",
        dFocusEnter: "dFocusEnter",
        dFocusExit: "dFocusExit"
    };
    var DirectionNames = {
        left: "left",
        right: "right",
        up: "up",
        down: "down"
    };
    var EventNames = {
        focusChanging: "focuschanging",
        focusChanged: "focuschanged"
    };
    var FocusableTagNames = [
        "A",
        "BUTTON",
        "IFRAME",
        "INPUT",
        "SELECT",
        "TEXTAREA"
    ];
    // These factors can be tweaked to adjust which elements are favored by the focus algorithm
    var ScoringConstants = {
        primaryAxisDistanceWeight: 30,
        secondaryAxisDistanceWeight: 20,
        percentInHistoryShadowWeight: 100000
    };
    /**
     * Gets the mapping object that maps keycodes to XYFocus actions.
    **/
    exports.keyCodeMap = {
        left: [],
        right: [],
        up: [],
        down: [],
        accept: [],
        cancel: [],
    };
    /**
     * Gets or sets the focus root when invoking XYFocus APIs.
    **/
    exports.focusRoot;
    function findNextFocusElement(direction, options) {
        var result = _findNextFocusElementInternal(direction, options);
        return result ? result.target : null;
    }
    exports.findNextFocusElement = findNextFocusElement;
    function moveFocus(direction, options) {
        var result = findNextFocusElement(direction, options);
        if (result) {
            var previousFocusElement = _Global.document.activeElement;
            if (_trySetFocus(result, -1)) {
                eventSrc.dispatchEvent(EventNames.focusChanged, { previousFocusElement: previousFocusElement, keyCode: -1 });
                return result;
            }
        }
        return null;
    }
    exports.moveFocus = moveFocus;
    // Privates
    var _lastTarget;
    var _cachedLastTargetRect;
    var _historyRect;
    /**
     * Executes XYFocus algorithm with the given parameters. Returns true if focus was moved, false otherwise.
     * @param direction The direction to move focus.
     * @param keyCode The key code of the pressed key.
     * @param (optional) A rectangle to use as the source coordinates for finding the next focusable element.
     * @param (optional) Indicates whether this focus request is allowed to propagate to its parent if we are in iframe.
    **/
    function _xyFocus(direction, keyCode, referenceRect, dontExit) {
        // If focus has moved since the last XYFocus movement, scrolling occured, or an explicit
        // reference rectangle was given to us, then we invalidate the history rectangle.
        if (referenceRect || _Global.document.activeElement !== _lastTarget) {
            _historyRect = null;
            _lastTarget = null;
            _cachedLastTargetRect = null;
        }
        else if (_lastTarget && _cachedLastTargetRect) {
            var lastTargetRect = _toIRect(_lastTarget.getBoundingClientRect());
            if (lastTargetRect.left !== _cachedLastTargetRect.left || lastTargetRect.top !== _cachedLastTargetRect.top) {
                _historyRect = null;
                _lastTarget = null;
                _cachedLastTargetRect = null;
            }
        }
        var activeElement = _Global.document.activeElement;
        var lastTarget = _lastTarget;
        var result = _findNextFocusElementInternal(direction, {
            focusRoot: exports.focusRoot,
            historyRect: _historyRect,
            referenceElement: _lastTarget,
            referenceRect: referenceRect
        });
        if (result && _trySetFocus(result.target, keyCode)) {
            // A focus target was found
            updateHistoryRect(direction, result);
            _lastTarget = result.target;
            _cachedLastTargetRect = result.targetRect;
            if (_ElementUtilities.hasClass(result.target, ClassNames.toggleMode)) {
                _ElementUtilities.removeClass(result.target, ClassNames.toggleModeActive);
            }
            if (result.target.tagName === "IFRAME") {
                var targetIframe = result.target;
                if (IFrameHelper.isXYFocusEnabled(targetIframe)) {
                    // If we successfully moved focus and the new focused item is an IFRAME, then we need to notify it
                    // Note on coordinates: When signaling enter, DO transform the coordinates into the child frame's coordinate system.
                    var refRect = _toIRect({
                        left: result.referenceRect.left - result.targetRect.left,
                        top: result.referenceRect.top - result.targetRect.top,
                        width: result.referenceRect.width,
                        height: result.referenceRect.height
                    });
                    var message = {};
                    message[CrossDomainMessageConstants.messageDataProperty] = {
                        type: CrossDomainMessageConstants.dFocusEnter,
                        direction: direction,
                        referenceRect: refRect
                    };
                    // postMessage API is safe even in cross-domain scenarios.
                    targetIframe.contentWindow.postMessage(message, "*");
                }
            }
            eventSrc.dispatchEvent(EventNames.focusChanged, { previousFocusElement: activeElement, keyCode: keyCode });
            return true;
        }
        else {
            // No focus target was found; if we are inside an IFRAME and focus is allowed to propagate out, notify the parent that focus is exiting this IFRAME
            // Note on coordinates: When signaling exit, do NOT transform the coordinates into the parent's coordinate system.
            if (!dontExit && top !== window) {
                var refRect = referenceRect;
                if (!refRect) {
                    refRect = _Global.document.activeElement ? _toIRect(_Global.document.activeElement.getBoundingClientRect()) : _defaultRect();
                }
                var message = {};
                message[CrossDomainMessageConstants.messageDataProperty] = {
                    type: CrossDomainMessageConstants.dFocusExit,
                    direction: direction,
                    referenceRect: refRect
                };
                // postMessage API is safe even in cross-domain scenarios.
                _Global.parent.postMessage(message, "*");
                return true;
            }
        }
        return false;
        // Nested Helpers
        function updateHistoryRect(direction, result) {
            var newHistoryRect = _defaultRect();
            // It's possible to get into a situation where the target element has no overlap with the reference edge.
            //
            //..╔══════════════╗..........................
            //..║   reference  ║..........................
            //..╚══════════════╝..........................
            //.....................╔═══════════════════╗..
            //.....................║                   ║..
            //.....................║       target      ║..
            //.....................║                   ║..
            //.....................╚═══════════════════╝..
            //
            // If that is the case, we need to reset the coordinates to the edge of the target element.
            if (direction === DirectionNames.left || direction === DirectionNames.right) {
                newHistoryRect.top = Math.max(result.targetRect.top, result.referenceRect.top, _historyRect ? _historyRect.top : Number.MIN_VALUE);
                newHistoryRect.bottom = Math.min(result.targetRect.bottom, result.referenceRect.bottom, _historyRect ? _historyRect.bottom : Number.MAX_VALUE);
                if (newHistoryRect.bottom <= newHistoryRect.top) {
                    newHistoryRect.top = result.targetRect.top;
                    newHistoryRect.bottom = result.targetRect.bottom;
                }
                newHistoryRect.height = newHistoryRect.bottom - newHistoryRect.top;
                newHistoryRect.width = Number.MAX_VALUE;
                newHistoryRect.left = Number.MIN_VALUE;
                newHistoryRect.right = Number.MAX_VALUE;
            }
            else {
                newHistoryRect.left = Math.max(result.targetRect.left, result.referenceRect.left, _historyRect ? _historyRect.left : Number.MIN_VALUE);
                newHistoryRect.right = Math.min(result.targetRect.right, result.referenceRect.right, _historyRect ? _historyRect.right : Number.MAX_VALUE);
                if (newHistoryRect.right <= newHistoryRect.left) {
                    newHistoryRect.left = result.targetRect.left;
                    newHistoryRect.right = result.targetRect.right;
                }
                newHistoryRect.width = newHistoryRect.right - newHistoryRect.left;
                newHistoryRect.height = Number.MAX_VALUE;
                newHistoryRect.top = Number.MIN_VALUE;
                newHistoryRect.bottom = Number.MAX_VALUE;
            }
            _historyRect = newHistoryRect;
        }
    }
    function _findNextFocusElementInternal(direction, options) {
        options = options || {};
        options.focusRoot = options.focusRoot || exports.focusRoot || _Global.document.body;
        options.historyRect = options.historyRect || _defaultRect();
        var maxDistance = Math.max(_Global.screen.availHeight, _Global.screen.availWidth);
        var refObj = getReferenceObject(options.referenceElement, options.referenceRect);
        // Handle override
        if (refObj.element) {
            var manualOverrideOptions = refObj.element.getAttribute(AttributeNames.focusOverride) || refObj.element.getAttribute(AttributeNames.focusOverrideLegacy);
            if (manualOverrideOptions) {
                var parsedOptions = _OptionsParser.optionsParser(manualOverrideOptions);
                // The left-hand side can be cased as either "left" or "Left".
                var selector = parsedOptions[direction] || parsedOptions[direction[0].toUpperCase() + direction.substr(1)];
                if (selector) {
                    var target;
                    var element = refObj.element;
                    while (!target && element) {
                        target = element.querySelector(selector);
                        element = element.parentElement;
                    }
                    if (target) {
                        if (target === _Global.document.activeElement) {
                            return null;
                        }
                        return { target: target, targetRect: _toIRect(target.getBoundingClientRect()), referenceRect: refObj.rect, usedOverride: true };
                    }
                }
            }
        }
        // Calculate scores for each element in the root
        var bestPotential = {
            element: null,
            rect: null,
            score: 0
        };
        var allElements = options.focusRoot.querySelectorAll("*");
        for (var i = 0, length = allElements.length; i < length; i++) {
            var potentialElement = allElements[i];
            if (refObj.element === potentialElement || !_isFocusable(potentialElement) || _isInInactiveToggleModeContainer(potentialElement)) {
                continue;
            }
            var potentialRect = _toIRect(potentialElement.getBoundingClientRect());
            // Skip elements that have either a width of zero or a height of zero
            if (potentialRect.width === 0 || potentialRect.height === 0) {
                continue;
            }
            var score = calculateScore(direction, maxDistance, options.historyRect, refObj.rect, potentialRect);
            if (score > bestPotential.score) {
                bestPotential.element = potentialElement;
                bestPotential.rect = potentialRect;
                bestPotential.score = score;
            }
        }
        return bestPotential.element ? { target: bestPotential.element, targetRect: bestPotential.rect, referenceRect: refObj.rect, usedOverride: false } : null;
        // Nested Helpers
        function calculatePercentInShadow(minReferenceCoord, maxReferenceCoord, minPotentialCoord, maxPotentialCoord) {
            /// Calculates the percentage of the potential element that is in the shadow of the reference element.
            if ((minReferenceCoord >= maxPotentialCoord) || (maxReferenceCoord <= minPotentialCoord)) {
                // Potential is not in the reference's shadow.
                return 0;
            }
            var pixelOverlap = Math.min(maxReferenceCoord, maxPotentialCoord) - Math.max(minReferenceCoord, minPotentialCoord);
            var shortEdge = Math.min(maxPotentialCoord - minPotentialCoord, maxReferenceCoord - minReferenceCoord);
            return shortEdge === 0 ? 0 : (pixelOverlap / shortEdge);
        }
        function calculateScore(direction, maxDistance, historyRect, referenceRect, potentialRect) {
            var score = 0;
            var percentInShadow;
            var primaryAxisDistance;
            var secondaryAxisDistance = 0;
            var percentInHistoryShadow = 0;
            switch (direction) {
                case DirectionNames.left:
                    // Make sure we don't evaluate any potential elements to the right of the reference element
                    if (potentialRect.left >= referenceRect.left) {
                        break;
                    }
                    percentInShadow = calculatePercentInShadow(referenceRect.top, referenceRect.bottom, potentialRect.top, potentialRect.bottom);
                    primaryAxisDistance = referenceRect.left - potentialRect.right;
                    if (percentInShadow > 0) {
                        percentInHistoryShadow = calculatePercentInShadow(historyRect.top, historyRect.bottom, potentialRect.top, potentialRect.bottom);
                    }
                    else {
                        // If the potential element is not in the shadow, then we calculate secondary axis distance
                        secondaryAxisDistance = (referenceRect.bottom <= potentialRect.top) ? (potentialRect.top - referenceRect.bottom) : referenceRect.top - potentialRect.bottom;
                    }
                    break;
                case DirectionNames.right:
                    // Make sure we don't evaluate any potential elements to the left of the reference element
                    if (potentialRect.right <= referenceRect.right) {
                        break;
                    }
                    percentInShadow = calculatePercentInShadow(referenceRect.top, referenceRect.bottom, potentialRect.top, potentialRect.bottom);
                    primaryAxisDistance = potentialRect.left - referenceRect.right;
                    if (percentInShadow > 0) {
                        percentInHistoryShadow = calculatePercentInShadow(historyRect.top, historyRect.bottom, potentialRect.top, potentialRect.bottom);
                    }
                    else {
                        // If the potential element is not in the shadow, then we calculate secondary axis distance
                        secondaryAxisDistance = (referenceRect.bottom <= potentialRect.top) ? (potentialRect.top - referenceRect.bottom) : referenceRect.top - potentialRect.bottom;
                    }
                    break;
                case DirectionNames.up:
                    // Make sure we don't evaluate any potential elements below the reference element
                    if (potentialRect.top >= referenceRect.top) {
                        break;
                    }
                    percentInShadow = calculatePercentInShadow(referenceRect.left, referenceRect.right, potentialRect.left, potentialRect.right);
                    primaryAxisDistance = referenceRect.top - potentialRect.bottom;
                    if (percentInShadow > 0) {
                        percentInHistoryShadow = calculatePercentInShadow(historyRect.left, historyRect.right, potentialRect.left, potentialRect.right);
                    }
                    else {
                        // If the potential element is not in the shadow, then we calculate secondary axis distance
                        secondaryAxisDistance = (referenceRect.right <= potentialRect.left) ? (potentialRect.left - referenceRect.right) : referenceRect.left - potentialRect.right;
                    }
                    break;
                case DirectionNames.down:
                    // Make sure we don't evaluate any potential elements above the reference element
                    if (potentialRect.bottom <= referenceRect.bottom) {
                        break;
                    }
                    percentInShadow = calculatePercentInShadow(referenceRect.left, referenceRect.right, potentialRect.left, potentialRect.right);
                    primaryAxisDistance = potentialRect.top - referenceRect.bottom;
                    if (percentInShadow > 0) {
                        percentInHistoryShadow = calculatePercentInShadow(historyRect.left, historyRect.right, potentialRect.left, potentialRect.right);
                    }
                    else {
                        // If the potential element is not in the shadow, then we calculate secondary axis distance
                        secondaryAxisDistance = (referenceRect.right <= potentialRect.left) ? (potentialRect.left - referenceRect.right) : referenceRect.left - potentialRect.right;
                    }
                    break;
            }
            if (primaryAxisDistance >= 0) {
                // The score needs to be a positive number so we make these distances positive numbers
                primaryAxisDistance = maxDistance - primaryAxisDistance;
                secondaryAxisDistance = maxDistance - secondaryAxisDistance;
                if (primaryAxisDistance >= 0 && secondaryAxisDistance >= 0) {
                    // Potential elements in the shadow get a multiplier to their final score
                    primaryAxisDistance += primaryAxisDistance * percentInShadow;
                    score = primaryAxisDistance * ScoringConstants.primaryAxisDistanceWeight + secondaryAxisDistance * ScoringConstants.secondaryAxisDistanceWeight + percentInHistoryShadow * ScoringConstants.percentInHistoryShadowWeight;
                }
            }
            return score;
        }
        function getReferenceObject(referenceElement, referenceRect) {
            var refElement;
            var refRect;
            if ((!referenceElement && !referenceRect) || (referenceElement && !referenceElement.parentNode)) {
                // Note: We need to check to make sure 'parentNode' is not null otherwise there is a case
                // where _lastTarget is defined, but calling getBoundingClientRect will throw a native exception.
                // This case happens if the innerHTML of the parent of the _lastTarget is set to "".
                // If no valid reference is supplied, we'll use _Global.document.activeElement unless it's the body
                if (_Global.document.activeElement !== _Global.document.body) {
                    referenceElement = _Global.document.activeElement;
                }
            }
            if (referenceElement) {
                refElement = referenceElement;
                refRect = _toIRect(refElement.getBoundingClientRect());
            }
            else if (referenceRect) {
                refRect = _toIRect(referenceRect);
            }
            else {
                refRect = _defaultRect();
            }
            return {
                element: refElement,
                rect: refRect
            };
        }
    }
    function _defaultRect() {
        // We set the top, left, bottom and right properties of the referenceBoundingRectangle to '-1'
        // (as opposed to '0') because we want to make sure that even elements that are up to the edge
        // of the screen can receive focus.
        return {
            top: -1,
            bottom: -1,
            right: -1,
            left: -1,
            height: 0,
            width: 0
        };
    }
    function _toIRect(rect) {
        return {
            top: Math.floor(rect.top),
            bottom: Math.floor(rect.top + rect.height),
            right: Math.floor(rect.left + rect.width),
            left: Math.floor(rect.left),
            height: Math.floor(rect.height),
            width: Math.floor(rect.width),
        };
    }
    function _trySetFocus(element, keyCode) {
        // We raise an event on the focusRoot before focus changes to give listeners
        // a chance to prevent the next focus target from receiving focus if they want.
        var canceled = eventSrc.dispatchEvent(EventNames.focusChanging, { nextFocusElement: element, keyCode: keyCode });
        if (!canceled) {
            element.focus();
        }
        return _Global.document.activeElement === element;
    }
    function _isFocusable(element) {
        var elementTagName = element.tagName;
        if (!element.hasAttribute("tabindex") && FocusableTagNames.indexOf(elementTagName) === -1 && !_ElementUtilities.hasClass(element, ClassNames.focusable)) {
            // If the current potential element is not one of the tags we consider to be focusable, then exit
            return false;
        }
        if (elementTagName === "IFRAME" && !IFrameHelper.isXYFocusEnabled(element)) {
            // Skip IFRAMEs without compatible XYFocus implementation
            return false;
        }
        if (elementTagName === "DIV" && element["winControl"] && element["winControl"].disabled) {
            // Skip disabled WinJS controls
            return false;
        }
        var style = _ElementUtilities._getComputedStyle(element);
        if (element.getAttribute("tabIndex") === "-1" || style.display === "none" || style.visibility === "hidden" || element.disabled) {
            // Skip elements that are hidden
            // Note: We don't check for opacity === 0, because the browser cannot tell us this value accurately.
            return false;
        }
        return true;
    }
    function _findParentToggleModeContainer(element) {
        var toggleModeRoot = element.parentElement;
        while (toggleModeRoot && !_isToggleMode(toggleModeRoot)) {
            toggleModeRoot = toggleModeRoot.parentElement;
        }
        return toggleModeRoot;
    }
    function _isInInactiveToggleModeContainer(element) {
        var container = _findParentToggleModeContainer(element);
        return container && !_ElementUtilities.hasClass(container, ClassNames.toggleModeActive);
    }
    function _isToggleMode(element) {
        if (_ElementUtilities.hasClass(element, ClassNames.toggleMode)) {
            return true;
        }
        if (element.tagName === "INPUT") {
            var inputType = element.type.toLowerCase();
            if (inputType === "date" || inputType === "datetime" || inputType === "datetime-local" || inputType === "email" || inputType === "month" || inputType === "number" || inputType === "password" || inputType === "range" || inputType === "search" || inputType === "tel" || inputType === "text" || inputType === "time" || inputType === "url" || inputType === "week") {
                return true;
            }
        }
        else if (element.tagName === "TEXTAREA") {
            return true;
        }
        return false;
    }
    function _getStateHandler(element) {
        var suspended = false;
        var toggleMode = false;
        var toggleModeActive = false;
        if (element) {
            suspended = _ElementUtilities._matchesSelector(element, "." + ClassNames.suspended + ", ." + ClassNames.suspended + " *");
            toggleMode = _isToggleMode(element);
            toggleModeActive = _ElementUtilities.hasClass(element, ClassNames.toggleModeActive);
        }
        var stateHandler = KeyHandlerStates.RestState;
        if (suspended) {
            stateHandler = KeyHandlerStates.SuspendedState;
        }
        else {
            if (toggleMode) {
                if (toggleModeActive) {
                    stateHandler = KeyHandlerStates.ToggleModeActiveState;
                }
                else {
                    stateHandler = KeyHandlerStates.ToggleModeRestState;
                }
            }
        }
        return stateHandler;
    }
    function _handleKeyEvent(e) {
        if (e.defaultPrevented) {
            return;
        }
        var stateHandler = _getStateHandler(document.activeElement);
        var direction = "";
        if (exports.keyCodeMap.up.indexOf(e.keyCode) !== -1) {
            direction = "up";
        }
        else if (exports.keyCodeMap.down.indexOf(e.keyCode) !== -1) {
            direction = "down";
        }
        else if (exports.keyCodeMap.left.indexOf(e.keyCode) !== -1) {
            direction = "left";
        }
        else if (exports.keyCodeMap.right.indexOf(e.keyCode) !== -1) {
            direction = "right";
        }
        if (direction) {
            var shouldPreventDefault = stateHandler.xyFocus(direction, e.keyCode);
            if (shouldPreventDefault) {
                e.preventDefault();
            }
        }
    }
    function _handleCaptureKeyEvent(e) {
        if (e.defaultPrevented) {
            return;
        }
        var activeElement = document.activeElement;
        var shouldPreventDefault = false;
        var stateHandler = _getStateHandler(document.activeElement);
        if (exports.keyCodeMap.accept.indexOf(e.keyCode) !== -1) {
            shouldPreventDefault = stateHandler.accept(activeElement);
        }
        else if (exports.keyCodeMap.cancel.indexOf(e.keyCode) !== -1) {
            shouldPreventDefault = stateHandler.cancel(activeElement);
        }
        if (shouldPreventDefault) {
            e.preventDefault();
        }
    }
    var KeyHandlerStates;
    (function (KeyHandlerStates) {
        // Element is not suspended and does not use toggle mode.
        var RestState = (function () {
            function RestState() {
            }
            RestState.accept = _clickElement;
            RestState.cancel = _nop;
            RestState.xyFocus = _xyFocus; // Prevent default when XYFocus moves focus
            return RestState;
        })();
        KeyHandlerStates.RestState = RestState;
        // Element has opted out of XYFocus.
        var SuspendedState = (function () {
            function SuspendedState() {
            }
            SuspendedState.accept = _nop;
            SuspendedState.cancel = _nop;
            SuspendedState.xyFocus = _nop;
            return SuspendedState;
        })();
        KeyHandlerStates.SuspendedState = SuspendedState;
        // Element uses toggle mode but is not toggled nor opted out of XYFocus.
        var ToggleModeRestState = (function () {
            function ToggleModeRestState() {
            }
            ToggleModeRestState.accept = function (element) {
                _ElementUtilities.addClass(element, ClassNames.toggleModeActive);
                return true;
            };
            ToggleModeRestState.cancel = _nop;
            ToggleModeRestState.xyFocus = _xyFocus; // Prevent default when XYFocus moves focus
            return ToggleModeRestState;
        })();
        KeyHandlerStates.ToggleModeRestState = ToggleModeRestState;
        // Element uses toggle mode and is toggled and did not opt out of XYFocus.
        var ToggleModeActiveState = (function () {
            function ToggleModeActiveState() {
            }
            ToggleModeActiveState.cancel = function (element) {
                element && _ElementUtilities.removeClass(element, ClassNames.toggleModeActive);
                return true;
            };
            ToggleModeActiveState.accept = _clickElement;
            ToggleModeActiveState.xyFocus = _nop;
            return ToggleModeActiveState;
        })();
        KeyHandlerStates.ToggleModeActiveState = ToggleModeActiveState;
        function _clickElement(element) {
            element && element.click && element.click();
            return false;
        }
        function _nop() {
            var args = [];
            for (var _i = 0; _i < arguments.length; _i++) {
                args[_i - 0] = arguments[_i];
            }
            return false;
        }
    })(KeyHandlerStates || (KeyHandlerStates = {}));
    var IFrameHelper;
    (function (IFrameHelper) {
        // XYFocus caches registered iframes and iterates over the cache for its focus navigation implementation.
        // However, since there is no reliable way for an iframe to unregister with its parent as it can be
        // spontaneously taken out of the DOM, the cache can go stale. This helper module makes sure that on
        // every query to the iframe cache, stale iframes are removed.
        // Furthermore, merely accessing an iframe that has been garbage collected by the platform will cause an
        // exception so each iteration during a query must be in a try/catch block.
        var iframes = [];
        function count() {
            // Iterating over it causes stale iframes to be cleared from the cache.
            _safeForEach(function () { return false; });
            return iframes.length;
        }
        IFrameHelper.count = count;
        function getIFrameFromWindow(win) {
            var iframes = _Global.document.querySelectorAll("IFRAME");
            var found = Array.prototype.filter.call(iframes, function (x) { return x.contentWindow === win; });
            return found.length ? found[0] : null;
        }
        IFrameHelper.getIFrameFromWindow = getIFrameFromWindow;
        function isXYFocusEnabled(iframe) {
            var found = false;
            _safeForEach(function (ifr) {
                if (ifr === iframe) {
                    found = true;
                }
            });
            return found;
        }
        IFrameHelper.isXYFocusEnabled = isXYFocusEnabled;
        function registerIFrame(iframe) {
            iframes.push(iframe);
        }
        IFrameHelper.registerIFrame = registerIFrame;
        function unregisterIFrame(iframe) {
            var index = -1;
            _safeForEach(function (ifr, i) {
                if (ifr === iframe) {
                    index = i;
                }
            });
            if (index !== -1) {
                iframes.splice(index, 1);
            }
        }
        IFrameHelper.unregisterIFrame = unregisterIFrame;
        function _safeForEach(callback) {
            for (var i = iframes.length - 1; i >= 0; i--) {
                try {
                    var iframe = iframes[i];
                    if (!iframe.contentWindow) {
                        iframes.splice(i, 1);
                    }
                    else {
                        callback(iframe, i);
                    }
                }
                catch (e) {
                    // Iframe has been GC'd
                    iframes.splice(i, 1);
                }
            }
        }
    })(IFrameHelper || (IFrameHelper = {}));
    if (_Global.document) {
        // Note: This module is not supported in WebWorker
        // Default mappings
        exports.keyCodeMap.left.push(Keys.GamepadLeftThumbstickLeft, Keys.GamepadDPadLeft, Keys.NavigationLeft);
        exports.keyCodeMap.right.push(Keys.GamepadLeftThumbstickRight, Keys.GamepadDPadRight, Keys.NavigationRight);
        exports.keyCodeMap.up.push(Keys.GamepadLeftThumbstickUp, Keys.GamepadDPadUp, Keys.NavigationUp);
        exports.keyCodeMap.down.push(Keys.GamepadLeftThumbstickDown, Keys.GamepadDPadDown, Keys.NavigationDown);
        exports.keyCodeMap.accept.push(Keys.GamepadA, Keys.NavigationAccept);
        exports.keyCodeMap.cancel.push(Keys.GamepadB, Keys.NavigationCancel);
        _Global.addEventListener("message", function (e) {
            // Note: e.source is the Window object of an iframe which could be hosting content
            // from a different domain. No properties on e.source should be accessed or we may
            // run into a cross-domain access violation exception.
            var sourceWindow = null;
            try {
                // Since messages are async, by the time we get this message, the iframe could've
                // been removed from the DOM and e.source is null or throws an exception on access.
                sourceWindow = e.source;
                if (!sourceWindow) {
                    return;
                }
            }
            catch (e) {
                return;
            }
            if (!e.data || !e.data[CrossDomainMessageConstants.messageDataProperty]) {
                return;
            }
            var data = e.data[CrossDomainMessageConstants.messageDataProperty];
            switch (data.type) {
                case CrossDomainMessageConstants.register:
                    var iframe = IFrameHelper.getIFrameFromWindow(sourceWindow);
                    iframe && IFrameHelper.registerIFrame(iframe);
                    break;
                case CrossDomainMessageConstants.unregister:
                    var iframe = IFrameHelper.getIFrameFromWindow(sourceWindow);
                    iframe && IFrameHelper.unregisterIFrame(iframe);
                    break;
                case CrossDomainMessageConstants.dFocusEnter:
                    // The coordinates stored in data.refRect are already in this frame's coordinate system.
                    // First try to focus anything within this iframe without leaving the current frame.
                    var focused = _xyFocus(data.direction, -1, data.referenceRect, true);
                    if (!focused) {
                        // No focusable element was found, we'll focus document.body if it is focusable.
                        if (_isFocusable(_Global.document.body)) {
                            _Global.document.body.focus();
                        }
                        else {
                            // Nothing within this iframe is focusable, we call _xyFocus again without a refRect
                            // and allow the request to propagate to the parent.
                            _xyFocus(data.direction, -1);
                        }
                    }
                    break;
                case CrossDomainMessageConstants.dFocusExit:
                    var iframe = IFrameHelper.getIFrameFromWindow(sourceWindow);
                    if (_Global.document.activeElement !== iframe) {
                        break;
                    }
                    // The coordinates stored in data.refRect are in the IFRAME's coordinate system,
                    // so we must first transform them into this frame's coordinate system.
                    var refRect = data.referenceRect;
                    var iframeRect = iframe.getBoundingClientRect();
                    refRect.left += iframeRect.left;
                    refRect.top += iframeRect.top;
                    if (typeof refRect.right === "number") {
                        refRect.right += iframeRect.left;
                    }
                    if (typeof refRect.bottom === "number") {
                        refRect.bottom += iframeRect.top;
                    }
                    _xyFocus(data.direction, -1, refRect);
                    break;
            }
        });
        _BaseUtils.ready().then(function () {
            if (_ElementUtilities.hasWinRT && _Global["Windows"] && _Global["Windows"]["Xbox"]) {
                _ElementUtilities.addClass(_Global.document.body, ClassNames.xboxPlatform);
            }
            // Subscribe on capture phase to prevent this key event from interacting with
            // the element/control if XYFocus handled it for accept/cancel keys.
            _Global.document.addEventListener("keydown", _handleCaptureKeyEvent, true);
            // Subscribe on bubble phase to allow developers to override XYFocus behaviors for directional keys.
            _Global.document.addEventListener("keydown", _handleKeyEvent);
            // If we are running within an iframe, we send a registration message to the parent window
            if (_Global.top !== _Global.window) {
                var message = {};
                message[CrossDomainMessageConstants.messageDataProperty] = {
                    type: CrossDomainMessageConstants.register,
                    version: 1.0
                };
                _Global.parent.postMessage(message, "*");
            }
        });
        // Publish to WinJS namespace
        var toPublish = {
            focusRoot: {
                get: function () {
                    return exports.focusRoot;
                },
                set: function (value) {
                    exports.focusRoot = value;
                }
            },
            findNextFocusElement: findNextFocusElement,
            keyCodeMap: exports.keyCodeMap,
            moveFocus: moveFocus,
            onfocuschanged: _Events._createEventProperty(EventNames.focusChanged),
            onfocuschanging: _Events._createEventProperty(EventNames.focusChanging),
            _xyFocus: _xyFocus,
            _iframeHelper: IFrameHelper
        };
        toPublish = _BaseUtils._merge(toPublish, _Events.eventMixin);
        toPublish["_listeners"] = {};
        var eventSrc = toPublish;
        _Base.Namespace.define("WinJS.UI.XYFocus", toPublish);
    }
});