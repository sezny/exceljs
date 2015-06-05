/**
 * Copyright (c) 2015 Guyon Roche
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";

var fs = require("fs");
var events = require("events");
var Stream = require("stream");
var Promise = require("bluebird");
var _ = require("underscore");
var unzip = require("unzip");

var utils = require("../../utils/utils");
var Enums = require("../../enums");
var StreamBuf = require("../../utils/stream-buf");

var RelType = require("../../xlsx/rel-type");
var StyleManager = require("../../xlsx/stylemanager");
var SharedStrings = require("../../utils/shared-strings");

var WorksheetReader = require("./worksheet-reader");
var HyperlinkReader = require("./hyperlink-reader");

var WorkbookReader = module.exports = function(options) {
    options = options || {};
    
    // until we actually parse a styles.xml file, just assume we're not handling styles
    // (but we do need to handle dates)
    this.styles = new StyleManager.Mock();
    
    // worksheet readers, indexed by sheetNo
    this.worksheetReaders = {};
    
    // hyperlink readers, indexed by sheetNo
    this.hyperlinkReaders = {};
}

utils.inherits(WorkbookReader, events.EventEmitter, {
    _getStream: function(input) {
        if (input instanceof Stream.Readable) {
            return input;
        }
        if (_.isString(input)) {
            return fs.createReadStream(input);
        }
        throw new Error("Could not recognise input");
    },
    options: {
        entries: ["emit"],
        sharedStrings: ["cache", "emit"],
        styles: ["cache"],
        hyperlinks: ["cache", "emit"],
        worksheets: ["emit"]
    },
    read: function(input, options) {
        var self = this;
        var stream = this._getStream(input);
        var zip = unzip.Parse();
        zip.on('entry',function (entry) {
            switch(entry.path) {
                case "_rels/.rels":
                case "xl/workbook.xml":
                case "xl/_rels/workbook.xml.rels":
                    entry.autodrain();
                    break;
                case "xl/sharedStrings.xml":
                    self.emit(options, {type: "shared-strings"});
                    self._parseSharedStrings(entry, options);
                    break;
                case "xl/styles.xml":
                    self.emit(options, {type: "styles"});
                    self._parseStyles(entry, options);
                    break;
                default:
                    if (entry.path.match(/xl\/worksheets\/sheet\d+\.xml/)) {
                        var match = entry.path.match(/xl\/worksheets\/sheet(\d+)\.xml/)
                        var sheetNo = match[1];
                        self.emit(options, {type: "worksheet", number: sheetNo});
                        self._parseWorksheet(entry, sheetNo, options);
                    } else if (entry.path.match(/xl\/worksheets\/_rels\/sheet\d+\.xml.rels/)) {
                        var match = entry.path.match(/xl\/worksheets\/_rels\/sheet(\d+)\.xml.rels/)
                        var sheetNo = match[1];
                        self.emit(options, {type: "worksheet-rels", number: sheetNo});
                        self._parseHyperlinks(entry, sheetNo, options);
                    } else {
                        entry.autodrain();
                    }
                    break;
            }
        });
        stream.on('close', function () {
            self.emit("finished");
        });
        stream.pipe(zip);
    },
    _emitEntry: function(options, payload) {
        if (options.entries === "emit") {
            this.emit("entry", payload);
        }
    },
    _parseSharedStrings: function(entry, options) {
        this._emitEntry(options, {type: "shared-strings"});
        var self = this;
        var sharedStrings = null;
        switch(options.sharedStrings) {
            case "cache":
                sharedStrings = this.sharedStrings = [];
                break;
            case "emit":
                break;
            default:
                entry.autodrain();
                return;
        }
        
        var parser = Sax.createStream(true, {});
        var inT = false;
        var t = null;
        var index = 0;
        var sharedStrings = [];
        parser.on('opentag', function(node) {
            if (node.name == "t") {
                t = null;
                inT = true;
            }
        });
        parser.on('closetag', function (name) {
            if (inT && (name == "t")) {
                if (sharedStrings) {
                    sharedStrings.push(t);
                } else {
                    self.emit("shared-string", { index: index++, text: t});
                }
                t = null;
            }
        });
        parser.on('text', function (text) {
            t = t ? t + text : text;
        });
        parser.on('error', function (error) {
            self.emit('error', error);
        });
        entry.pipe(parser);
    },
    _parseStyles: function(entry, options) {
        this._emitEntry(options, {type: "styles"});
        if (options.styles !== "cache") {
            entry.autodrain();
            return;
        }
        this.styles = new StyleManager();
        this.styles.parse(entry);
    },
    _parseWorksheet: function(entry, sheetNo, options) {
        this._emitEntry(options, {type: "worksheet", id: sheetNo});
        var worksheetReader = this.worksheetReaders[sheetNo];
        if (!worksheetReader) {
            worksheetReader = this.worksheetReaders[sheetNo] = new WorksheetReader(this, sheetNo);
        }
        
        if (options.worksheets === "emit") {
            this.emit("worksheet", worksheetReader);
        }
        worksheetReader.read(entry, options, this.hyperlinkReaders[sheetNo]);
    },
    _parseHyperlinks: function(entry, sheetNo, options) {
        this._emitEntry(options, {type: "hyerlinks", id: sheetNo});
        var hyperlinksReader = new HyperlinkReader(this, sheetNo);
        if (options.hyperlinks === "emit") {
            this.emit("hyperlinks", hyperlinksReader);
        }
        hyperlinksReader.read(entry, options);
    }
});