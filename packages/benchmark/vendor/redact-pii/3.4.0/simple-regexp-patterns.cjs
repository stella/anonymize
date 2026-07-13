"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.url = exports.digits = exports.credentials = exports.password = exports.username = exports.emailAddress = exports.usSocialSecurityNumber = exports.ipAddress = exports.phoneNumber = exports.zipcode = exports.streetAddress = exports.creditCardNumber = void 0;
const aptRegex = /(apt|bldg|dept|fl|hngr|lot|pier|rm|ste|slip|trlr|unit|#)\.? *[a-z0-9-]+\b/gi;
const poBoxRegex = /P\.? ?O\.? *Box +\d+/gi;
const roadRegex = /(street|st|road|rd|avenue|ave|drive|dr|loop|court|ct|circle|cir|lane|ln|boulevard|blvd|way)\.?\b/gi;
exports.creditCardNumber = /\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}|\d{4}[ -]?\d{6}[ -]?\d{4}\d?/g;
exports.streetAddress = new RegExp('(\\d+\\s*(\\w+ ){1,2}' + roadRegex.source + '(\\s+' + aptRegex.source + ')?)|(' + poBoxRegex.source + ')', 'gi');
exports.zipcode = /\b\d{5}\b(-\d{4})?\b/g;
exports.phoneNumber = /(\(?\+?[0-9]{1,2}\)?[-. ]?)?(\(?[0-9]{3}\)?|[0-9]{3})[-. ]?([0-9]{3}[-. ]?[0-9]{4}|\b[A-Z0-9]{7}\b)/g;
exports.ipAddress = /(\d{1,3}(\.\d{1,3}){3}|[0-9A-F]{4}(:[0-9A-F]{4}){5}(::|(:0000)+))/gi;
exports.usSocialSecurityNumber = /\b\d{3}[ -.]\d{2}[ -.]\d{4}\b/g;
exports.emailAddress = /([a-z0-9_\-.+]+)@\w+(\.\w+)*/gi;
exports.username = /(user( ?name)?|login): \S+/gi;
exports.password = /(pass(word|phrase)?|secret): \S+/gi;
exports.credentials = /(login( cred(ential)?s| info(rmation)?)?|cred(ential)?s) ?:\s*\S+\s+\/?\s*\S+/gi;
exports.digits = /\b\d{4,}\b/g;
exports.url = /([^\s:/?#]+):\/\/([^/?#\s]*)([^?#\s]*)(\?([^#\s]*))?(#([^\s]*))?/g;
//# sourceMappingURL=simple-regexp-patterns.js.map