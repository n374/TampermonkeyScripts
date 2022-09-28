// ==UserScript==
// @name         YouTube Dual Subtitles / Youtube 双语字幕
// @version      0.1.0
// @description  Show dual sutitles in YouTube player, based on https://github.com/CoinkWang/Y2BDoubleSubs
// @author       n374
// @match        *://www.youtube.com/watch?v=*
// @match        *://www.youtube.com
// @match        *://www.youtube.com/*
// @require      https://unpkg.com/ajax-hook@2.0.2/dist/ajaxhook.min.js
// @grant        none
// @namespace    https://github.com/n374/TampermonkeyScripts
// ==/UserScript==

(function() {
    let localeLang = navigator.language ? navigator.language : 'en'
    let perferedLang = ["zh", "zh-Hans", "zh-Hant"]
    let enLang = ["en", "en-GB"]
    let langsMap = undefined

    function getCaption(url) {
        if (url == undefined) {
            return undefined
        }

        let xhr = new XMLHttpRequest();
        // Use RegExp to clean '&tlang=...' in our xhr request params while using Y2B auto translate.
        xhr.open('GET', url + `&fmt=json3&translate_h00ked`, false);
        xhr.send();
        return JSON.parse(xhr.response)
    }

    function parseLangsMap(response) {
        let langsMap = new Map()
        let captions = response.captions.playerCaptionsTracklistRenderer.captionTracks
        for (let i = 0; i < captions.length; i++) {
            if (captions[i].kind == "asr") {
                continue
            }
            langsMap.set(captions[i].languageCode, captions[i].baseUrl)
        }
        return langsMap
    }

    function mergeSegs(first, second, currentOrder) {
        let obj = new Object()
        obj.tStartMs = first.tStartMs
        obj.dDurationMs = first.dDurationMs
        obj.segs = [new Object]

        function onelineSeg(event) {
            let line = ''
            event.segs.forEach(seg => (line += seg.utf8));
            return line
        }

        let firstStr = first == undefined ? "　" : onelineSeg(first)
        let secondStr = second == undefined ? "　" : onelineSeg(second)

        if (currentOrder) {
            obj.segs[0].utf8 = firstStr + "\n" + secondStr
        } else {
            obj.segs[0].utf8 = secondStr + "\n" + firstStr
        }
        return obj
    }

    function mergeCaption(left, right) {
        // when length of segments are not the same (e.g. automatic generated english subs)
        var lEvents = left.events.filter(event => event.aAppend !== 1 && event.segs)
        var rEvents = right.events.filter(event => event.aAppend !== 1 && event.segs)

        var lLen = lEvents.length
        var rLen = rEvents.length

        var lIdx = 0
        var rIdx = 0

        var res = []
        while (lIdx < lLen && rIdx < rLen) {
            let l = lEvents[lIdx]
            let r = rEvents[rIdx]

            let early = l.tStartMs > r.tStartMs ? r : l
            let late = l.tStartMs > r.tStartMs ? l : r

            // two separate event
            if (early.tStartMs + early.dDurationMs <= late.tStartMs) {
                res.push(mergeSegs(early, undefined, early == l))
                early == l ? lIdx++ : rIdx++
                continue
            }

//            ◁───head────▷◁────new early────
//
//            ┌───────────╦──────────────────
//            │
//    early   │           ║
//            │
//            └───────────╩──────────────────
//                        ┌──────────────────
//                        │
//               late     │
//                        │
//                        └──────────────────

            // chop the head off
            if (early.tStartMs != late.tStartMs) {
                let head = mergeSegs(early, undefined, early == l)
                head.dDurationMs = late.tStartMs - early.tStartMs
                early.tStartMs = late.tStartMs
                early.dDurationMs -= head.dDurationMs
                res.push(head)
            }

            let long = early.dDurationMs > late.dDurationMs ? early : late
            let short = early.dDurationMs > late.dDurationMs ? late : early
//          ┌────────────────╦─────────────┐
//          │                              │
//   long   │                ║             │
//          │                              │
//          └─────────────┬──╩─────────────┘
//          ◁────overlap────▷ ◁─new long──▷
//          ┌─────────────┼──┐
//          │                │
//  short   │             │  │
//          │                │
//          └──┬──────────┼──┘
//
//          ┌──▼──────────▼──┐
//          │                │
//          │      merge     │
//          │                │
//          └────────────────┘
            // merge the overlaps
            res.push(mergeSegs(short, long, short == l))

            if (long.dDurationMs == short.dDurationMs) {
                lIdx++
                rIdx++
                continue
            }
            long.tStartMs += short.dDurationMs
            long.dDurationMs -= short.dDurationMs
            long == l ? rIdx++ : lIdx++
        }

        left.events = res
        return left
    }

    // https://stackoverflow.com/a/64961272
    const {fetch: origFetch} = window;
    window.fetch = async (...args) => {
        var found = false
        var url
        for (var i = 0; i < args.length; i++) {
            if (args[i].url != undefined && args[i].url.includes("/v1/player?")) {
                url = args[i].url
                found = true
            }
        }


        if (found) {
            console.log("fetch called with url:", url);
        }

        const response = await origFetch(...args);

        /* work with the cloned response in a separate promise
         chain -- could use the same chain with `await`. */
        if (found) {
            response
                .clone()
                .json()
                .then(body => {
                langsMap = parseLangsMap(body)
            });
        }

        /* the original response can be resolved unmodified: */
        return response;
    };

    // localeLang = 'zh'  // uncomment this line to define the language you wish here
    ah.proxy({
        onRequest: (config, handler) => {
            handler.next(config);
        },
        onResponse: (response, handler) => {
            if (!response.config.url.includes('/api/timedtext') || response.config.url.includes('&translate_h00ked')) {
                handler.resolve(response)
                return;
            }

            console.log("handling " + response.config.url)
            if (langsMap == undefined) {
                langsMap = parseLangsMap(ytInitialPlayerResponse)
            }

            var cnCaption
            for (let i = 0; i < perferedLang.length; i++) {
                if (langsMap.get(perferedLang[i]) != undefined) {
                    cnCaption = getCaption(langsMap.get(perferedLang[i]))
                    break
                }
            }

            var enCaption
            for (let i = 0; i < enLang.length; i++) {
                if (langsMap.get(enLang[i]) != undefined) {
                    enCaption = getCaption(langsMap.get(enLang[i]))
                    break
                }
            }

            // if we can only get one caption or none
            if (cnCaption == undefined && enCaption == undefined) {
                console.log("no cn or en caption found")
                handler.resolve(response)
                return
            }
            if (cnCaption == undefined) {
                console.log("en caption found")
                response.response = JSON.stringify(enCaption)
                handler.resolve(response)
                return
            }
            if (enCaption == undefined) {
                console.log("cn caption found")
                response.response = JSON.stringify(cnCaption)
                handler.resolve(response)
                return
            }


            response.response = JSON.stringify(mergeCaption(cnCaption, enCaption))
            handler.resolve(response)
        }
    })
})();
