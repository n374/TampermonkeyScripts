// ==UserScript==
// @name         YouTube Dual Subtitles / Youtube 双语字幕
// @version      0.1.2
// @description  Show dual sutitles in YouTube player, based on https://github.com/CoinkWang/Y2BDoubleSubs
// @author       n374
// @match        *://www.youtube.com/watch?v=*
// @match        *://www.youtube.com
// @match        *://www.youtube.com/*
// @require      https://unpkg.com/ajax-hook@2.1.3/dist/ajaxhook.min.js
// @grant        none
// @namespace    https://github.com/n374/TampermonkeyScripts
// ==/UserScript==

(function() {
    // Customisable，support js regex (add '^' & '$' automatically)
    const perferedLang = ["zh", "zh-Hans", "zh-.*"]
    const secondLang = ["en", "en-.*"]



    const placeholder = " "
    const hookedParameter = "&translate_h00ked"
    const subAPI = "/api/timedtext"
    let langSet = undefined

    // get subtitles for specific language with a url for other language
    function getCaptionWithLang(url, lang) {
        if (lang == undefined) {
            return
        }
        let reg = new RegExp("(^|[&?])lang=([^&]*)", 'g');

        let xhr = new XMLHttpRequest();
        // Use RegExp to replace parameter lang
        let newUrl = url.replace(reg, "&lang=" + lang) + hookedParameter
        xhr.open('GET', newUrl, false);
        xhr.send();
        try {
            return JSON.parse(xhr.response)
        } catch (err) {
            console.log(`failed to parse ${newUrl} with err: ${err.message}, result ${xhr.response}`)
        }
    }

    // extract language set from API response
    function extractLangs(response) {
        let langSet = new Set()
        let captions = response.captions.playerCaptionsTracklistRenderer.captionTracks
        for (let i = 0; i < captions.length; i++) {
            if (captions[i].kind == "asr") {
                continue
            }
            langSet.add(captions[i].languageCode)
        }
        return langSet
    }

    // find first match language in perferd list
    function matchLang(perferedList, langList) {
        for (const perfer of perferedList) {
            for (const lang of langList) {
                let re = new RegExp("^" + perfer + "$")
                if (lang.match(re)) {
                    return lang
                }
            }
        }
    }

    // merge segs of two event with specific order
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

        let firstStr = first == undefined ? placeholder : onelineSeg(first)
        let secondStr = second == undefined ? placeholder : onelineSeg(second)

        if (currentOrder) {
            obj.segs[0].utf8 = firstStr + "\n" + secondStr
        } else {
            obj.segs[0].utf8 = secondStr + "\n" + firstStr
        }
        return obj
    }

    // merge two captions
    function mergeCaption(left, right) {
        let lEvents = left.events.filter(event => event.aAppend !== 1 && event.segs)
        let rEvents = right.events.filter(event => event.aAppend !== 1 && event.segs)

        let lLen = lEvents.length
        let rLen = rEvents.length

        let lIdx = 0
        let rIdx = 0

        let res = []
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

    // intercept fetch() API to hook new player by create a mock 'window'
    // https://stackoverflow.com/a/64961272
    const {fetch: origFetch} = window;
    window.fetch = async (...args) => {
        let found = false
        let url
        for (let i = 0; i < args.length; i++) {
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
                langSet = extractLangs(body)
            });
        }

        /* the original response can be resolved unmodified: */
        return response;
    };


    // add hook to ajax request to modify subtitles
    ah.proxy({
        onRequest: (config, handler) => {
            handler.next(config);
        },
        onResponse: (response, handler) => {
            let url = response.config.url
            if (!url.includes(subAPI) || url.includes(hookedParameter)) {
                handler.resolve(response)
                return;
            }

            if (langSet == undefined) {
                langSet = extractLangs(ytInitialPlayerResponse)
            }

            let firstMatch = matchLang(perferedLang, langSet)
            let firstCaption = getCaptionWithLang(url, firstMatch)

            let secondMatch = matchLang(secondLang, langSet)
            let secondCaption = getCaptionWithLang(url, secondMatch)


            // if we can only get one caption or none
            if (firstCaption == undefined && secondCaption == undefined) {
                console.log("no caption found")
                handler.resolve(response)
                return
            }
            if (firstCaption == undefined) {
                console.log(`only second caption '${secondMatch}' found`)
                response.response = JSON.stringify(secondCaption)
                handler.resolve(response)
                return
            }
            if (secondCaption == undefined) {
                console.log(`only first caption '${firstMatch}' found`)
                response.response = JSON.stringify(firstCaption)
                handler.resolve(response)
                return
            }

            console.log(`found caption: ${firstMatch}, ${secondMatch}`)
            response.response = JSON.stringify(mergeCaption(firstCaption, secondCaption))
            handler.resolve(response)
        }
    })
})();
