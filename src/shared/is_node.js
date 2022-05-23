/* Copyright 2018 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* globals process */

// NW.js / Electron / BrightSign is a browser context,
// but copies some Node.js objects; see
// http://docs.nwjs.io/en/latest/For%20Users/Advanced/JavaScript%20Contexts%20in%20NW.js/#access-nodejs-and-nwjs-api-in-browser-context
// https://www.electronjs.org/docs/api/process#processversionselectron-readonly
// https://www.electronjs.org/docs/api/process#processtype-readonly
// https://brightsign.atlassian.net/wiki/spaces/DOC/pages/370672370/BSDeviceInfo
const isNodeJS =
  (typeof PDFJSDev === "undefined" || PDFJSDev.test("GENERIC")) &&
  typeof process === "object" &&
  process + "" === "[object process]" &&
  !process.versions.nw &&
  !(process.versions.electron && process.type && process.type !== "browser") &&
  !(window && window.BSDeviceInfo);

export { isNodeJS };
