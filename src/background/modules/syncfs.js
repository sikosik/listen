SyncFS = (function() {
    "use strict";

    var ID3V1_START = "TAG";
    var NULLSTRING = String.fromCharCode(0);

    var pendingDownloads = []; // список URL скачиваемых файлов
    var cachedCounter = -1;

    chrome.syncFileSystem.onFileStatusChanged.addListener(function (details) {
        if (details.direction !== "remote_to_local")
            return;

        cachedCounter = -1;
        updateCurrentCounter();
    });

    chrome.runtime.onMessage.addListener(function (req, sender, sendResponse) {
        if (req.action === "currentSyncFSCounter") {
            sendResponse(SyncFS.getCurrentCounterValue());
        } else if (req.action === "saveGoogleDrive") {
            SyncFS.save(req.artist, req.title, req.url);
        }
    });


    /**
     * Создание безопасной строки длиной bytesLength байт
     *
     * @param {String} str
     * @param {Number} bytesLength
     * @return {String}
     */
    function makeSafeString(str, bytesLength) {
        var output = "";
        var nullString = String.fromCharCode(0);
        var index = 0;
        var totalBytesLength = 0;
        var code, bytes;

        while (totalBytesLength < bytesLength) {
            if (index === -1 || index >= str.length) {
                output += nullString;
                totalBytesLength += 1;
            } else {
                code = str.charCodeAt(index);

                if (code < 128) { // 1 byte
                    output += str[index];

                    index += 1;
                    totalBytesLength += 1;
                } else {
                    bytes = (code >= 128 && code < 2048) ? 2 : 3;

                    if (totalBytesLength + bytes > bytesLength) { // когда сумма не вмещается в 30 байт, не добавляем символ
                        index = -1;
                    } else {
                        output += str[index];

                        index += 1;
                        totalBytesLength += bytes;
                    }
                }
            }
        }

        return output;
    }

    function readBinary(blob, callback) {
        var reader = new FileReader;
        reader.onloadend = function () {
            callback(reader.result);
        };

        reader.readAsBinaryString(blob);
    }

    function updateCurrentCounter() {
        chrome.syncFileSystem.requestFileSystem(function (fs) {
            var dirReader = fs.root.createReader();

            dirReader.readEntries(function (results) {
                cachedCounter = 0;

                for (var i = 0; i < results.length; i++) {
                    if (/\.mp3$/.test(results.item(i).name)) {
                        cachedCounter += 1;
                    }
                }

                notifyAppWindows();
            });
        });
    }

    function notifyAppWindows() {
        chrome.runtime.sendMessage({
            action: "syncFsCounterUpdted",
            value: SyncFS.getCurrentCounterValue()
        });
    }


    return {
        /**
         * Возвращает текущее состояние счетчика
         */
        getCurrentCounterValue: function SyncFS_getCurrentCounterValue() {
            if (cachedCounter === -1) {
                updateCurrentCounter();
                return "...";
            }

            var output;

            if (cachedCounter > 0) {
                output = cachedCounter;
                if (pendingDownloads.length) {
                    output += "+";
                }
            } else {
                output = pendingDownloads.length ? "..." : "";
            }

            return output;
        },

        /**
         * Save file into sync filesystem
         *
         * @param {String} artist
         * @param {String} title
         * @param {String} url
         */
        save: function SyncFS_save(artist, title, url) {
            artist = artist.trim();
            title = title.trim();

            if (pendingDownloads.indexOf(url) !== -1)
                return;

            pendingDownloads.push(url);
            notifyAppWindows();

            loadResource(url, {
                responseType: "blob",
                timeout: 0,
                onload: function (blob) {
                    var tagStart = blob.size - 128;

                    parallel({
                        tag: function (callback) {
                            readBinary(blob.slice(tagStart, tagStart + 3, "text/plain"), callback);
                        },
                        artist: function (callback) {
                            readBinary(blob.slice(tagStart + 33, tagStart + 63, "text/plain"), callback);
                        },
                        title: function (callback) {
                            readBinary(blob.slice(tagStart + 3, tagStart + 33, "text/plain"), callback);
                        }
                    }, function (res) {
                        if (res.tag !== "TAG") {
                            var tagData = ID3V1_START;
                            var totalBytesLength = 3;

                            tagData += makeSafeString(title, 30);
                            tagData += makeSafeString(artist, 30);

                            for (var i = 63; i < 128; i++) {
                                tagData += NULLSTRING;
                            }

                            console.log("Construct new blob from original data and tag data: %s", tagData);
                            blob = new Blob([blob, tagData], {type: "audio/mpeg"});
                        }

                        chrome.syncFileSystem.requestFileSystem(function (fs) {
                            fs.root.getFile(artist + " - " + title + ".mp3", {create: true}, function (fileEntry) {
                                fileEntry.createWriter(function (fileWriter) {
                                    fileWriter.onwriteend = function (evt) {
                                        var index = pendingDownloads.indexOf(url);
                                        pendingDownloads.splice(index, 1);

                                        cachedCounter += 1;
                                        notifyAppWindows();
                                    };

                                    fileWriter.onprogress = function (evt) {
                                        var percents = Math.floor((evt.loaded / evt.total) * 100);
                                        console.log("[%s] %i percents of file written", url, percents);
                                    };

                                    fileWriter.onerror = function (evt) {
                                        console.error("Write failed: " + evt);

                                        var index = pendingDownloads.indexOf(url);
                                        pendingDownloads.splice(index, 1);

                                        notifyAppWindows();
                                    };

                                    fileWriter.write(blob);
                                });
                            });
                        });
                    });
                },
                onerror: function (error) {
                    console.error(error);

                    var index = pendingDownloads.indexOf(url);
                    pendingDownloads.splice(index, 1);

                    notifyAppWindows();
                },
                onprogress: function (percents) {
                    console.log("[%s] %i percents downloaded", url, percents);
                }
            });
        }
    };
})();