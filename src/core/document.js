/* Copyright 2012 Mozilla Foundation
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
/* eslint no-var: error */

import {
  assert,
  FormatError,
  info,
  InvalidPDFException,
  isArrayBuffer,
  isArrayEqual,
  isBool,
  isNum,
  isSpace,
  isString,
  OPS,
  shadow,
  stringToBytes,
  stringToPDFString,
  Util,
  warn,
} from "../shared/util";
import { Catalog, ObjectLoader, XRef } from "./obj";
import { Dict, isDict, isName, isStream, Ref } from "./primitives";
import {
  getInheritableProperty,
  MissingDataException,
  XRefEntryException,
  XRefParseException,
} from "./core_utils";
import { NullStream, Stream, StreamsSequenceStream } from "./stream";
import { AnnotationFactory } from "./annotation";
import { calculateMD5 } from "./crypto";
import { Linearization } from "./parser";
import { OperatorList } from "./operator_list";
import { PartialEvaluator } from "./evaluator";
import { PDFFunctionFactory } from "./function";

const DEFAULT_USER_UNIT = 1.0;
const LETTER_SIZE_MEDIABOX = [0, 0, 612, 792];


// EDITED BY LOGAN
function isAnnotationRenderable(annotation, intent) {
  if (self.disableFlattenedAnnotations) {
    return false;
  }

  if (annotation.data.annotationFlags !== 4) {
    annotation.data.forceRender = true;
    return true;
  }

  return (
    (intent === "display" && annotation.viewable) ||
    (intent === "print" && annotation.printable)
  );
}

class Page {
  constructor({
    pdfManager,
    xref,
    pageIndex,
    pageDict,
    ref,
    fontCache,
    builtInCMapCache,
    pdfFunctionFactory,
  }) {
    this.pdfManager = pdfManager;
    this.pageIndex = pageIndex;
    this.pageDict = pageDict;
    this.xref = xref;
    this.ref = ref;
    this.fontCache = fontCache;
    this.builtInCMapCache = builtInCMapCache;
    this.pdfFunctionFactory = pdfFunctionFactory;
    this.evaluatorOptions = pdfManager.evaluatorOptions;
    this.resourcesPromise = null;

    const idCounters = {
      obj: 0,
    };
    this.idFactory = {
      createObjId() {
        return `p${pageIndex}_${++idCounters.obj}`;
      },
      getDocId() {
        return `g_${pdfManager.docId}`;
      },
    };
  }

  /**
   * @private
   */
  _getInheritableProperty(key, getArray = false) {
    const value = getInheritableProperty({
      dict: this.pageDict,
      key,
      getArray,
      stopWhenFound: false,
    });
    if (!Array.isArray(value)) {
      return value;
    }
    if (value.length === 1 || !isDict(value[0])) {
      return value[0];
    }
    return Dict.merge(this.xref, value);
  }

  get content() {
    return this.pageDict.get("Contents");
  }

  get resources() {
    // For robustness: The spec states that a \Resources entry has to be
    // present, but can be empty. Some documents still omit it; in this case
    // we return an empty dictionary.
    return shadow(
      this,
      "resources",
      this._getInheritableProperty("Resources") || Dict.empty
    );
  }

  _getBoundingBox(name) {
    const box = this._getInheritableProperty(name, /* getArray = */ true);

    if (Array.isArray(box) && box.length === 4) {
      if (box[2] - box[0] !== 0 && box[3] - box[1] !== 0) {
        return box;
      }
      warn(`Empty /${name} entry.`);
    }
    return null;
  }

  get mediaBox() {
    // Reset invalid media box to letter size.
    return shadow(
      this,
      "mediaBox",
      this._getBoundingBox("MediaBox") || LETTER_SIZE_MEDIABOX
    );
  }

  get cropBox() {
    // Reset invalid crop box to media box.
    return shadow(
      this,
      "cropBox",
      this._getBoundingBox("CropBox") || this.mediaBox
    );
  }

  get userUnit() {
    let obj = this.pageDict.get("UserUnit");
    if (!isNum(obj) || obj <= 0) {
      obj = DEFAULT_USER_UNIT;
    }
    return shadow(this, "userUnit", obj);
  }

  get view() {
    // From the spec, 6th ed., p.963:
    // "The crop, bleed, trim, and art boxes should not ordinarily
    // extend beyond the boundaries of the media box. If they do, they are
    // effectively reduced to their intersection with the media box."
    const { cropBox, mediaBox } = this;
    let view;
    if (cropBox === mediaBox || isArrayEqual(cropBox, mediaBox)) {
      view = mediaBox;
    } else {
      const box = Util.intersect(cropBox, mediaBox);
      if (box && box[2] - box[0] !== 0 && box[3] - box[1] !== 0) {
        view = box;
      } else {
        warn("Empty /CropBox and /MediaBox intersection.");
      }
    }
    return shadow(this, "view", view || mediaBox);
  }

  get rotate() {
    let rotate = this._getInheritableProperty("Rotate") || 0;

    // Normalize rotation so it's a multiple of 90 and between 0 and 270.
    if (rotate % 90 !== 0) {
      rotate = 0;
    } else if (rotate >= 360) {
      rotate = rotate % 360;
    } else if (rotate < 0) {
      // The spec doesn't cover negatives. Assume it's counterclockwise
      // rotation. The following is the other implementation of modulo.
      rotate = ((rotate % 360) + 360) % 360;
    }
    return shadow(this, "rotate", rotate);
  }

  getContentStream() {
    const content = this.content;
    let stream;

    if (Array.isArray(content)) {
      // Fetching the individual streams from the array.
      const xref = this.xref;
      const streams = [];
      for (const stream of content) {
        streams.push(xref.fetchIfRef(stream));
      }
      stream = new StreamsSequenceStream(streams);
    } else if (isStream(content)) {
      stream = content;
    } else {
      // Replace non-existent page content with empty content.
      stream = new NullStream();
    }
    return stream;
  }

  loadResources(keys) {
    if (!this.resourcesPromise) {
      // TODO: add async `_getInheritableProperty` and remove this.
      this.resourcesPromise = this.pdfManager.ensure(this, "resources");
    }
    return this.resourcesPromise.then(() => {
      const objectLoader = new ObjectLoader(this.resources, keys, this.xref);
      return objectLoader.load();
    });
  }

  getOperatorList({ handler, sink, task, intent, renderInteractiveForms }) {
    const contentStreamPromise = this.pdfManager.ensure(
      this,
      "getContentStream"
    );
    const resourcesPromise = this.loadResources([
      "ExtGState",
      "ColorSpace",
      "Pattern",
      "Shading",
      "XObject",
      "Font",
    ]);

    const partialEvaluator = new PartialEvaluator({
      xref: this.xref,
      handler,
      pageIndex: this.pageIndex,
      idFactory: this.idFactory,
      fontCache: this.fontCache,
      builtInCMapCache: this.builtInCMapCache,
      options: this.evaluatorOptions,
      pdfFunctionFactory: this.pdfFunctionFactory,
    });

    const dataPromises = Promise.all([contentStreamPromise, resourcesPromise]);
    const pageListPromise = dataPromises.then(([contentStream]) => {
      const opList = new OperatorList(intent, sink, this.pageIndex);

      handler.send("StartRenderPage", {
        transparency: partialEvaluator.hasBlendModes(this.resources),
        pageIndex: this.pageIndex,
        intent,
      });

      return partialEvaluator
        .getOperatorList({
          stream: contentStream,
          task,
          resources: this.resources,
          operatorList: opList,
        })
        .then(function() {
          return opList;
        });
    });

    // Fetch the page's annotations and add their operator lists to the
    // page's operator list to render them.
    return Promise.all([pageListPromise, this._parsedAnnotations]).then(
      function([pageOpList, annotations]) {
        if (annotations.length === 0) {
          pageOpList.flush(true);
          return { length: pageOpList.totalLength };
        }

        // Collect the operator list promises for the annotations. Each promise
        // is resolved with the complete operator list for a single annotation.
        const opListPromises = [];
        for (const annotation of annotations) {
          if (isAnnotationRenderable(annotation, intent)) {
            // EDITED BY LOGAN
            opListPromises.push(
              annotation.getOperatorList(
                partialEvaluator,
                task,
                renderInteractiveForms
              )
            );
          }
        }

        return Promise.all(opListPromises).then(function(opLists) {
          pageOpList.addOp(OPS.beginAnnotations, []);
          for (const opList of opLists) {
            pageOpList.addOpList(opList);
          }
          pageOpList.addOp(OPS.endAnnotations, []);
          pageOpList.flush(true);
          return { length: pageOpList.totalLength };
        });
      }
    );
  }

  extractTextContent({
    handler,
    task,
    normalizeWhitespace,
    sink,
    combineTextItems,
  }) {
    const contentStreamPromise = this.pdfManager.ensure(
      this,
      "getContentStream"
    );
    const resourcesPromise = this.loadResources([
      "ExtGState",
      "XObject",
      "Font",
    ]);

    const dataPromises = Promise.all([contentStreamPromise, resourcesPromise]);
    return dataPromises.then(([contentStream]) => {
      const partialEvaluator = new PartialEvaluator({
        xref: this.xref,
        handler,
        pageIndex: this.pageIndex,
        idFactory: this.idFactory,
        fontCache: this.fontCache,
        builtInCMapCache: this.builtInCMapCache,
        options: this.evaluatorOptions,
        pdfFunctionFactory: this.pdfFunctionFactory,
      });

      return partialEvaluator.getTextContent({
        stream: contentStream,
        task,
        resources: this.resources,
        normalizeWhitespace,
        combineTextItems,
        sink,
      });
    });
  }

  getAnnotationsData(intent) {
    return this._parsedAnnotations.then(function(annotations) {
      const annotationsData = [];
      for (let i = 0, ii = annotations.length; i < ii; i++) {
        if (!intent || isAnnotationRenderable(annotations[i], intent)) {
          annotationsData.push(annotations[i].data);
        }
      }
      return annotationsData;
    });
  }

  get annotations() {
    return shadow(
      this,
      "annotations",
      this._getInheritableProperty("Annots") || []
    );
  }

  get _parsedAnnotations() {
    const parsedAnnotations = this.pdfManager
      .ensure(this, "annotations")
      .then(() => {
        const annotationRefs = this.annotations;
        const annotationPromises = [];
        for (let i = 0, ii = annotationRefs.length; i < ii; i++) {
          annotationPromises.push(
            AnnotationFactory.create(
              this.xref,
              annotationRefs[i],
              this.pdfManager,
              this.idFactory,
              annotationRefs
            )
          );
        }

        function isInkOverlapping(inkAnnotation, widgetAnnotation) {
          const widgetRect = widgetAnnotation.rectangle;
          const annotationRect = inkAnnotation.rectangle;
          return !(
            widgetRect[0] > annotationRect[2] ||
            annotationRect[0] > widgetRect[2] ||
            widgetRect[1] > annotationRect[3] ||
            annotationRect[1] > widgetRect[3]
          );
        }

        return Promise.all(annotationPromises).then(
          function(annotations) {
            // EDITED BY LOGAN
            // The code below blocks rendering of signature widgets if an ink annotation is found that overlaps it.
            const [widgets, inks] = annotations.reduce(
              (acc, annot) => {
                if (annot.type === "InkAnnotation") {
                  acc[1].push(annot);
                }

                if (annot.data.fieldType === "Sig") {
                  acc[0].push(annot);
                }
                return acc;
              },
              [[], []]
            );

            for (const ink of inks) {
              for (const widget of widgets) {
                if (isInkOverlapping(ink, widget)) {
                  widget.data.blockRender = true;
                }
              }
            }

            return annotations.filter(function isDefined(annotation) {
              return !!annotation;
            });
          },
          function(reason) {
            warn(`_parsedAnnotations: "${reason}".`);
            return [];
          }
        );
      });

    return shadow(this, "_parsedAnnotations", parsedAnnotations);
  }
}

const PDF_HEADER_SIGNATURE = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
// prettier-ignore
const STARTXREF_SIGNATURE = new Uint8Array([
  0x73, 0x74, 0x61, 0x72, 0x74, 0x78, 0x72, 0x65, 0x66]);
const ENDOBJ_SIGNATURE = new Uint8Array([0x65, 0x6e, 0x64, 0x6f, 0x62, 0x6a]);

const FINGERPRINT_FIRST_BYTES = 1024;
const EMPTY_FINGERPRINT =
  "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00";

function find(stream, signature, limit = 1024, backwards = false) {
  if (
    typeof PDFJSDev === "undefined" ||
    PDFJSDev.test("!PRODUCTION || TESTING")
  ) {
    assert(limit > 0, 'The "limit" must be a positive integer.');
  }
  const signatureLength = signature.length;

  const scanBytes = stream.peekBytes(limit);
  const scanLength = scanBytes.length - signatureLength;

  if (scanLength <= 0) {
    return false;
  }
  if (backwards) {
    const signatureEnd = signatureLength - 1;

    let pos = scanBytes.length - 1;
    while (pos >= signatureEnd) {
      let j = 0;
      while (
        j < signatureLength &&
        scanBytes[pos - j] === signature[signatureEnd - j]
      ) {
        j++;
      }
      if (j >= signatureLength) {
        // `signature` found.
        stream.pos += pos - signatureEnd;
        return true;
      }
      pos--;
    }
  } else {
    // forwards
    let pos = 0;
    while (pos <= scanLength) {
      let j = 0;
      while (j < signatureLength && scanBytes[pos + j] === signature[j]) {
        j++;
      }
      if (j >= signatureLength) {
        // `signature` found.
        stream.pos += pos;
        return true;
      }
      pos++;
    }
  }
  return false;
}

/**
 * The `PDFDocument` class holds all the (worker-thread) data of the PDF file.
 */
class PDFDocument {
  constructor(pdfManager, arg) {
    let stream;
    if (isStream(arg)) {
      stream = arg;
    } else if (isArrayBuffer(arg)) {
      stream = new Stream(arg);
    } else {
      throw new Error("PDFDocument: Unknown argument type");
    }
    if (stream.length <= 0) {
      throw new InvalidPDFException(
        "The PDF file is empty, i.e. its size is zero bytes."
      );
    }

    this.pdfManager = pdfManager;
    this.stream = stream;
    this.xref = new XRef(stream, pdfManager);

    this.pdfFunctionFactory = new PDFFunctionFactory({
      xref: this.xref,
      isEvalSupported: pdfManager.evaluatorOptions.isEvalSupported,
    });
    this._pagePromises = [];
  }

  parse(recoveryMode) {
    this.setup(recoveryMode);

    const version = this.catalog.catDict.get("Version");
    if (isName(version)) {
      this.pdfFormatVersion = version.name;
    }

    // Check if AcroForms are present in the document.
    try {
      this.acroForm = this.catalog.catDict.get("AcroForm");
      if (this.acroForm) {
        this.xfa = this.acroForm.get("XFA");
        const fields = this.acroForm.get("Fields");
        if ((!Array.isArray(fields) || fields.length === 0) && !this.xfa) {
          this.acroForm = null; // No fields and no XFA, so it's not a form.
        }
      }
    } catch (ex) {
      if (ex instanceof MissingDataException) {
        throw ex;
      }
      info("Cannot fetch AcroForm entry; assuming no AcroForms are present");
      this.acroForm = null;
    }

    // Check if a Collection dictionary is present in the document.
    try {
      const collection = this.catalog.catDict.get("Collection");
      if (isDict(collection) && collection.getKeys().length > 0) {
        this.collection = collection;
      }
    } catch (ex) {
      if (ex instanceof MissingDataException) {
        throw ex;
      }
      info("Cannot fetch Collection dictionary.");
    }
  }

  get linearization() {
    let linearization = null;
    try {
      linearization = Linearization.create(this.stream);
    } catch (err) {
      if (err instanceof MissingDataException) {
        throw err;
      }
      info(err);
    }
    return shadow(this, "linearization", linearization);
  }

  get startXRef() {
    const stream = this.stream;
    let startXRef = 0;

    if (this.linearization) {
      // Find the end of the first object.
      stream.reset();
      if (find(stream, ENDOBJ_SIGNATURE)) {
        startXRef = stream.pos + 6 - stream.start;
      }
    } else {
      // Find `startxref` by checking backwards from the end of the file.
      const step = 1024;
      const startXRefLength = STARTXREF_SIGNATURE.length;
      let found = false,
        pos = stream.end;

      while (!found && pos > 0) {
        pos -= step - startXRefLength;
        if (pos < 0) {
          pos = 0;
        }
        stream.pos = pos;
        found = find(stream, STARTXREF_SIGNATURE, step, true);
      }

      if (found) {
        stream.skip(9);
        let ch;
        do {
          ch = stream.getByte();
        } while (isSpace(ch));
        let str = "";
        while (ch >= /* Space = */ 0x20 && ch <= /* '9' = */ 0x39) {
          str += String.fromCharCode(ch);
          ch = stream.getByte();
        }
        startXRef = parseInt(str, 10);
        if (isNaN(startXRef)) {
          startXRef = 0;
        }
      }
    }
    return shadow(this, "startXRef", startXRef);
  }

  // Find the header, get the PDF format version and setup the
  // stream to start from the header.
  checkHeader() {
    const stream = this.stream;
    stream.reset();

    if (!find(stream, PDF_HEADER_SIGNATURE)) {
      // May not be a PDF file, but don't throw an error and let
      // parsing continue.
      return;
    }
    stream.moveStart();

    // Read the PDF format version.
    const MAX_PDF_VERSION_LENGTH = 12;
    let version = "",
      ch;
    while ((ch = stream.getByte()) > /* Space = */ 0x20) {
      if (version.length >= MAX_PDF_VERSION_LENGTH) {
        break;
      }
      version += String.fromCharCode(ch);
    }
    if (!this.pdfFormatVersion) {
      // Remove the "%PDF-" prefix.
      this.pdfFormatVersion = version.substring(5);
    }
  }

  parseStartXRef() {
    this.xref.setStartXRef(this.startXRef);
  }

  setup(recoveryMode) {
    this.xref.parse(recoveryMode);
    this.catalog = new Catalog(this.pdfManager, this.xref);
  }

  get numPages() {
    const linearization = this.linearization;
    const num = linearization ? linearization.numPages : this.catalog.numPages;
    return shadow(this, "numPages", num);
  }

  get documentInfo() {
    const DocumentInfoValidators = {
      Title: isString,
      Author: isString,
      Subject: isString,
      Keywords: isString,
      Creator: isString,
      Producer: isString,
      CreationDate: isString,
      ModDate: isString,
      Trapped: isName,
    };

    const docInfo = {
      PDFFormatVersion: this.pdfFormatVersion,
      IsLinearized: !!this.linearization,
      IsAcroFormPresent: !!this.acroForm,
      IsXFAPresent: !!this.xfa,
      IsCollectionPresent: !!this.collection,
    };

    let infoDict;
    try {
      infoDict = this.xref.trailer.get("Info");
    } catch (err) {
      if (err instanceof MissingDataException) {
        throw err;
      }
      info("The document information dictionary is invalid.");
    }

    if (isDict(infoDict)) {
      // Fill the document info with valid entries from the specification,
      // as well as any existing well-formed custom entries.
      for (const key of infoDict.getKeys()) {
        const value = infoDict.get(key);

        if (DocumentInfoValidators[key]) {
          // Make sure the (standard) value conforms to the specification.
          if (DocumentInfoValidators[key](value)) {
            docInfo[key] =
              typeof value !== "string" ? value : stringToPDFString(value);
          } else {
            info(`Bad value in document info for "${key}".`);
          }
        } else if (typeof key === "string") {
          // For custom values, only accept white-listed types to prevent
          // errors that would occur when trying to send non-serializable
          // objects to the main-thread (for example `Dict` or `Stream`).
          let customValue;
          if (isString(value)) {
            customValue = stringToPDFString(value);
          } else if (isName(value) || isNum(value) || isBool(value)) {
            customValue = value;
          } else {
            info(`Unsupported value in document info for (custom) "${key}".`);
            continue;
          }

          if (!docInfo["Custom"]) {
            docInfo["Custom"] = Object.create(null);
          }
          docInfo["Custom"][key] = customValue;
        }
      }
    }
    return shadow(this, "documentInfo", docInfo);
  }

  get fingerprint() {
    let hash;
    const idArray = this.xref.trailer.get("ID");
    if (
      Array.isArray(idArray) &&
      idArray[0] &&
      isString(idArray[0]) &&
      idArray[0] !== EMPTY_FINGERPRINT
    ) {
      hash = stringToBytes(idArray[0]);
    } else {
      hash = calculateMD5(
        this.stream.getByteRange(0, FINGERPRINT_FIRST_BYTES),
        0,
        FINGERPRINT_FIRST_BYTES
      );
    }

    const fingerprintBuf = [];
    for (let i = 0, ii = hash.length; i < ii; i++) {
      const hex = hash[i].toString(16);
      fingerprintBuf.push(hex.padStart(2, "0"));
    }
    return shadow(this, "fingerprint", fingerprintBuf.join(""));
  }

  _getLinearizationPage(pageIndex) {
    const { catalog, linearization } = this;
    assert(linearization && linearization.pageFirst === pageIndex);

    const ref = Ref.get(linearization.objectNumberFirst, 0);
    return this.xref
      .fetchAsync(ref)
      .then(obj => {
        // Ensure that the object that was found is actually a Page dictionary.
        if (
          isDict(obj, "Page") ||
          (isDict(obj) && !obj.has("Type") && obj.has("Contents"))
        ) {
          if (ref && !catalog.pageKidsCountCache.has(ref)) {
            catalog.pageKidsCountCache.put(ref, 1); // Cache the Page reference.
          }
          return [obj, ref];
        }
        throw new FormatError(
          "The Linearization dictionary doesn't point " +
            "to a valid Page dictionary."
        );
      })
      .catch(reason => {
        info(reason);
        return catalog.getPageDict(pageIndex);
      });
  }

  getPage(pageIndex) {
    if (this._pagePromises[pageIndex] !== undefined) {
      return this._pagePromises[pageIndex];
    }
    const { catalog, linearization } = this;

    const promise =
      linearization && linearization.pageFirst === pageIndex
        ? this._getLinearizationPage(pageIndex)
        : catalog.getPageDict(pageIndex);

    return (this._pagePromises[pageIndex] = promise.then(([pageDict, ref]) => {
      return new Page({
        pdfManager: this.pdfManager,
        xref: this.xref,
        pageIndex,
        pageDict,
        ref,
        fontCache: catalog.fontCache,
        builtInCMapCache: catalog.builtInCMapCache,
        pdfFunctionFactory: this.pdfFunctionFactory,
      });
    }));
  }

  checkFirstPage() {
    return this.getPage(0).catch(async reason => {
      if (reason instanceof XRefEntryException) {
        // Clear out the various caches to ensure that we haven't stored any
        // inconsistent and/or incorrect state, since that could easily break
        // subsequent `this.getPage` calls.
        this._pagePromises.length = 0;
        await this.cleanup();

        throw new XRefParseException();
      }
    });
  }

  fontFallback(id, handler) {
    return this.catalog.fontFallback(id, handler);
  }

  cleanup() {
    return this.catalog.cleanup();
  }
}

export { Page, PDFDocument };
