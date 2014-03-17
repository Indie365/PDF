/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
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
/* globals assert, assertWellFormed, ColorSpace, DecodeStream, Dict, Encodings,
           error, ErrorFont, Font, FontTranslator, FONT_IDENTITY_MATRIX,
           fontCharsToUnicode, FontFlags, ImageKind, info, isArray, isCmd,
           isDict, isEOF, isName, isNum, isStream, isString, JpegStream, Lexer,
           Metrics, Name, Parser, Pattern, PDFImage, PDFJS, serifFonts,
           stdFontMap, symbolsFonts, getTilingPatternIR, warn, Util, Promise,
           LegacyPromise, RefSetCache, isRef, TextRenderingMode, CMapFactory,
           OPS, UNSUPPORTED_FEATURES, UnsupportedManager */

'use strict';

var PartialEvaluator = (function PartialEvaluatorClosure() {
  function PartialEvaluator(pdfManager, xref, handler, pageIndex,
                            uniquePrefix, idCounters, fontCache) {
    this.state = new EvalState();
    this.stateStack = [];

    this.pdfManager = pdfManager;
    this.xref = xref;
    this.handler = handler;
    this.pageIndex = pageIndex;
    this.uniquePrefix = uniquePrefix;
    this.idCounters = idCounters;
    this.fontTranslator = new FontTranslator(this.xref, fontCache, this);
  }

  var TILING_PATTERN = 1, SHADING_PATTERN = 2;

  PartialEvaluator.prototype = {
    hasBlendModes: function PartialEvaluator_hasBlendModes(resources) {
      if (!isDict(resources)) {
        return false;
      }

      var nodes = [resources];
      while (nodes.length) {
        var node = nodes.shift();
        // First check the current resources for blend modes.
        var graphicStates = node.get('ExtGState');
        if (isDict(graphicStates)) {
          graphicStates = graphicStates.getAll();
          for (var key in graphicStates) {
            var graphicState = graphicStates[key];
            var bm = graphicState['BM'];
            if (isName(bm) && bm.name !== 'Normal') {
              return true;
            }
          }
        }
        // Descend into the XObjects to look for more resources and blend modes.
        var xObjects = node.get('XObject');
        if (!isDict(xObjects)) {
          continue;
        }
        xObjects = xObjects.getAll();
        for (var key in xObjects) {
          var xObject = xObjects[key];
          if (!isStream(xObject)) {
            continue;
          }
          var xResources = xObject.dict.get('Resources');
          // Only add the resource if it's different from the current one,
          // otherwise we can get stuck in an infinite loop.
          if (isDict(xResources) && xResources !== node) {
            nodes.push(xResources);
          }
        }
      }
      return false;
    },

    buildFormXObject: function PartialEvaluator_buildFormXObject(resources,
                                                                 xobj, smask,
                                                                 operatorList,
                                                                 state) {
      var matrix = xobj.dict.get('Matrix');
      var bbox = xobj.dict.get('BBox');
      var group = xobj.dict.get('Group');
      if (group) {
        var groupOptions = {
          matrix: matrix,
          bbox: bbox,
          smask: smask,
          isolated: false,
          knockout: false
        };

        var groupSubtype = group.get('S');
        if (isName(groupSubtype) && groupSubtype.name === 'Transparency') {
          groupOptions.isolated = group.get('I') || false;
          groupOptions.knockout = group.get('K') || false;
          var colorSpace = group.get('CS');
          groupOptions.colorSpace = colorSpace ?
            ColorSpace.parseToIR(colorSpace, this.xref, resources) : null;
        }
        operatorList.addOp(OPS.beginGroup, [groupOptions]);
      }

      operatorList.addOp(OPS.paintFormXObjectBegin, [matrix, bbox]);

      this.getOperatorList(xobj, xobj.dict.get('Resources') || resources,
                           operatorList, state);
      operatorList.addOp(OPS.paintFormXObjectEnd, []);

      if (group) {
        operatorList.addOp(OPS.endGroup, [groupOptions]);
      }
    },

    buildPaintImageXObject: function PartialEvaluator_buildPaintImageXObject(
                                resources, image, inline, operatorList,
                                cacheKey, cache) {
      var self = this;
      var dict = image.dict;
      var w = dict.get('Width', 'W');
      var h = dict.get('Height', 'H');

      if (PDFJS.maxImageSize !== -1 && w * h > PDFJS.maxImageSize) {
        warn('Image exceeded maximum allowed size and was removed.');
        return;
      }

      var imageMask = dict.get('ImageMask', 'IM') || false;
      if (imageMask) {
        // This depends on a tmpCanvas beeing filled with the
        // current fillStyle, such that processing the pixel
        // data can't be done here. Instead of creating a
        // complete PDFImage, only read the information needed
        // for later.

        var width = dict.get('Width', 'W');
        var height = dict.get('Height', 'H');
        var bitStrideLength = (width + 7) >> 3;
        var imgArray = image.getBytes(bitStrideLength * height);
        var decode = dict.get('Decode', 'D');
        var canTransfer = image instanceof DecodeStream;
        var inverseDecode = !!decode && decode[0] > 0;

        var imgData = PDFImage.createMask(imgArray, width, height,
                                          canTransfer, inverseDecode);
        imgData.cached = true;
        var args = [imgData];
        operatorList.addOp(OPS.paintImageMaskXObject, args);
        if (cacheKey) {
          cache.key = cacheKey;
          cache.fn = OPS.paintImageMaskXObject;
          cache.args = args;
        }
        return;
      }

      var softMask = dict.get('SMask', 'SM') || false;
      var mask = dict.get('Mask') || false;

      var SMALL_IMAGE_DIMENSIONS = 200;
      // Inlining small images into the queue as RGB data
      if (inline && !softMask && !mask &&
          !(image instanceof JpegStream) &&
          (w + h) < SMALL_IMAGE_DIMENSIONS) {
        var imageObj = new PDFImage(this.xref, resources, image,
                                    inline, null, null);
        // We force the use of RGBA_32BPP images here, because we can't handle
        // any other kind.
        var imgData = imageObj.createImageData(/* forceRGBA = */ true);
        operatorList.addOp(OPS.paintInlineImageXObject, [imgData]);
        return;
      }

      // If there is no imageMask, create the PDFImage and a lot
      // of image processing can be done here.
      var uniquePrefix = this.uniquePrefix || '';
      var objId = 'img_' + uniquePrefix + (++this.idCounters.obj);
      operatorList.addDependency(objId);
      var args = [objId, w, h];

      if (!softMask && !mask && image instanceof JpegStream &&
          image.isNativelySupported(this.xref, resources)) {
        // These JPEGs don't need any more processing so we can just send it.
        operatorList.addOp(OPS.paintJpegXObject, args);
        this.handler.send(
            'obj', [objId, this.pageIndex, 'JpegStream', image.getIR()]);
        return;
      }


      PDFImage.buildImage(function(imageObj) {
          var imgData = imageObj.createImageData(/* forceRGBA = */ false);
          self.handler.send('obj', [objId, self.pageIndex, 'Image', imgData],
                            null, [imgData.data.buffer]);
        }, self.handler, self.xref, resources, image, inline);
      operatorList.addOp(OPS.paintImageXObject, args);
      if (cacheKey) {
        cache.key = cacheKey;
        cache.fn = OPS.paintImageXObject;
        cache.args = args;
      }
    },

    handleSMask: function PartialEvaluator_handleSmask(smask, resources,
                                                       operatorList) {
      var smaskContent = smask.get('G');
      var smaskOptions = {
        subtype: smask.get('S').name,
        backdrop: smask.get('BC')
      };

      this.buildFormXObject(resources, smaskContent, smaskOptions,
                            operatorList);
    },

    handleTilingType: function PartialEvaluator_handleTilingType(
                          fn, args, resources, pattern, patternDict,
                          operatorList) {
      // Create an IR of the pattern code.
      var tilingOpList = this.getOperatorList(pattern,
                                  patternDict.get('Resources') || resources);
      // Add the dependencies to the parent operator list so they are resolved
      // before sub operator list is executed synchronously.
      operatorList.addDependencies(tilingOpList.dependencies);
      operatorList.addOp(fn, getTilingPatternIR({
                               fnArray: tilingOpList.fnArray,
                               argsArray: tilingOpList.argsArray
                              }, patternDict, args));
    },

    handleSetFont: function PartialEvaluator_handleSetFont(
                      resources, fontArgs, fontRef, operatorList) {

      // TODO(mack): Not needed?
      var fontName;
      if (fontArgs) {
        fontArgs = fontArgs.slice();
        fontName = fontArgs[0].name;
      }
      var self = this;
      var font = this.fontTranslator.getLoadableFont(fontName, fontRef,
                                                     this.xref, resources,
                                                     operatorList);
      this.state.font = font;
      var loadedName = font.loadedName;
      if (!font.sent) {
        var fontData = font.translated.exportData();

        self.handler.send('commonobj', [
          loadedName,
          'Font',
          fontData
        ]);
        font.sent = true;
      }

      return loadedName;
    },

    handleText: function PartialEvaluator_handleText(chars) {
      var font = this.state.font.translated;
      var glyphs = font.charsToGlyphs(chars);
      var isAddToPathSet = !!(this.state.textRenderingMode &
                              TextRenderingMode.ADD_TO_PATH_FLAG);
      if (font.data && (isAddToPathSet || PDFJS.disableFontFace)) {
        for (var i = 0; i < glyphs.length; i++) {
          if (glyphs[i] === null) {
            continue;
          }
          var fontChar = glyphs[i].fontChar;
          if (!font.renderer.hasBuiltPath(fontChar)) {
            var path = font.renderer.getPathJs(fontChar);
            this.handler.send('commonobj', [
              font.loadedName + '_path_' + fontChar,
              'FontPath',
              path
            ]);
          }
        }
      }

      return glyphs;
    },

    setGState: function PartialEvaluator_setGState(resources, gState,
                                                   operatorList, xref) {

      var self = this;
      // TODO(mack): This should be rewritten so that this function returns
      // what should be added to the queue during each iteration
      function setGStateForKey(gStateObj, key, value) {
        switch (key) {
          case 'Type':
            break;
          case 'LW':
          case 'LC':
          case 'LJ':
          case 'ML':
          case 'D':
          case 'RI':
          case 'FL':
          case 'CA':
          case 'ca':
            gStateObj.push([key, value]);
            break;
          case 'Font':
            var loadedName = self.handleSetFont(resources, null, value[0],
                                                operatorList);
            operatorList.addDependency(loadedName);
            gStateObj.push([key, [loadedName, value[1]]]);
            break;
          case 'BM':
            gStateObj.push([key, value]);
            break;
          case 'SMask':
            if (isName(value) && value.name === 'None') {
              gStateObj.push([key, false]);
              break;
            }
            var dict = xref.fetchIfRef(value);
            if (isDict(dict)) {
              self.handleSMask(dict, resources, operatorList);
              gStateObj.push([key, true]);
            } else {
              warn('Unsupported SMask type');
            }

            break;
          // Only generate info log messages for the following since
          // they are unlikey to have a big impact on the rendering.
          case 'OP':
          case 'op':
          case 'OPM':
          case 'BG':
          case 'BG2':
          case 'UCR':
          case 'UCR2':
          case 'TR':
          case 'TR2':
          case 'HT':
          case 'SM':
          case 'SA':
          case 'AIS':
          case 'TK':
            // TODO implement these operators.
            info('graphic state operator ' + key);
            break;
          default:
            info('Unknown graphic state operator ' + key);
            break;
        }
      }

      // This array holds the converted/processed state data.
      var gStateObj = [];
      var gStateMap = gState.map;
      for (var key in gStateMap) {
        var value = gStateMap[key];
        setGStateForKey(gStateObj, key, value);
      }

      operatorList.addOp(OPS.setGState, [gStateObj]);
    },

    getOperatorList: function PartialEvaluator_getOperatorList(stream,
                                                               resources,
                                                               operatorList,
                                                               evaluatorState) {

      var self = this;
      var xref = this.xref;
      var handler = this.handler;
      var imageCache = {};

      operatorList = operatorList || new OperatorList();

      resources = resources || new Dict();
      var xobjs = resources.get('XObject') || new Dict();
      var patterns = resources.get('Pattern') || new Dict();
      var preprocessor = new EvaluatorPreprocessor(stream, xref);
      if (evaluatorState) {
        preprocessor.setState(evaluatorState);
      }

      var promise = new LegacyPromise();
      var operation;
      while ((operation = preprocessor.read())) {
          var args = operation.args;
          var fn = operation.fn;

          switch (fn) {
            case OPS.setStrokeColorN:
            case OPS.setFillColorN:
              if (args[args.length - 1].code) {
                break;
              }
              // compile tiling patterns
              var patternName = args[args.length - 1];
              // SCN/scn applies patterns along with normal colors
              var pattern;
              if (isName(patternName) &&
                  (pattern = patterns.get(patternName.name))) {

                var dict = isStream(pattern) ? pattern.dict : pattern;
                var typeNum = dict.get('PatternType');

                if (typeNum == TILING_PATTERN) {
                  self.handleTilingType(fn, args, resources, pattern, dict,
                                        operatorList);
                  args = [];
                  continue;
                } else if (typeNum == SHADING_PATTERN) {
                  var shading = dict.get('Shading');
                  var matrix = dict.get('Matrix');
                  var pattern = Pattern.parseShading(shading, matrix, xref,
                                                      resources);
                  args = pattern.getIR();
                } else {
                  error('Unkown PatternType ' + typeNum);
                }
              }
              break;
            case OPS.paintXObject:
              if (args[0].code) {
                break;
              }
              // eagerly compile XForm objects
              var name = args[0].name;
              if (imageCache.key === name) {
                operatorList.addOp(imageCache.fn, imageCache.args);
                args = [];
                continue;
              }

              var xobj = xobjs.get(name);
              if (xobj) {
                assertWellFormed(
                    isStream(xobj), 'XObject should be a stream');

                var type = xobj.dict.get('Subtype');
                assertWellFormed(
                  isName(type),
                  'XObject should have a Name subtype'
                );

                if ('Form' == type.name) {
                  self.buildFormXObject(resources, xobj, null, operatorList,
                                        preprocessor.getState());
                  args = [];
                  continue;
                } else if ('Image' == type.name) {
                  self.buildPaintImageXObject(resources, xobj, false,
                                              operatorList, name, imageCache);
                  args = [];
                  continue;
                } else {
                  error('Unhandled XObject subtype ' + type.name);
                }
              }
              break;
            case OPS.setFont:
              // eagerly collect all fonts
              var loadedName = self.handleSetFont(resources, args, null,
                                                  operatorList);
              operatorList.addDependency(loadedName);
              args[0] = loadedName;
              break;
            case OPS.endInlineImage:
              var cacheKey = args[0].cacheKey;
              if (cacheKey && imageCache.key === cacheKey) {
                operatorList.addOp(imageCache.fn, imageCache.args);
                args = [];
                continue;
              }
              self.buildPaintImageXObject(resources, args[0], true,
                                          operatorList, cacheKey, imageCache);
              args = [];
              continue;
            case OPS.save:
              var old = this.state;
              this.stateStack.push(this.state);
              this.state = old.clone();
              break;
            case OPS.restore:
              var prev = this.stateStack.pop();
              if (prev) {
                this.state = prev;
              }
              break;
            case OPS.showText:
              args[0] = this.handleText(args[0]);
              break;
            case OPS.showSpacedText:
              var arr = args[0];
              var arrLength = arr.length;
              for (var i = 0; i < arrLength; ++i) {
                if (isString(arr[i])) {
                  arr[i] = this.handleText(arr[i]);
                }
              }
              break;
            case OPS.nextLineShowText:
              args[0] = this.handleText(args[0]);
              break;
            case OPS.nextLineSetSpacingShowText:
              args[2] = this.handleText(args[2]);
              break;
            case OPS.setTextRenderingMode:
              this.state.textRenderingMode = args[0];
              break;
            // Parse the ColorSpace data to a raw format.
            case OPS.setFillColorSpace:
            case OPS.setStrokeColorSpace:
              args = [ColorSpace.parseToIR(args[0], xref, resources)];
              break;
            case OPS.shadingFill:
              var shadingRes = resources.get('Shading');
              if (!shadingRes)
                error('No shading resource found');

              var shading = shadingRes.get(args[0].name);
              if (!shading)
                error('No shading object found');

              var shadingFill = Pattern.parseShading(
                  shading, null, xref, resources);
              var patternIR = shadingFill.getIR();
              args = [patternIR];
              fn = OPS.shadingFill;
              break;
            case OPS.setGState:
              var dictName = args[0];
              var extGState = resources.get('ExtGState');

              if (!isDict(extGState) || !extGState.has(dictName.name))
                break;

              var gState = extGState.get(dictName.name);
              self.setGState(resources, gState, operatorList, xref);
              args = [];
              continue;
          } // switch

          operatorList.addOp(fn, args);
      }

      // some pdf don't close all restores inside object/form
      // closing those for them
      for (var i = 0, ii = preprocessor.savedStatesDepth; i < ii; i++) {
        operatorList.addOp(OPS.restore, []);
      }

      return operatorList;
    },

    getTextContent: function PartialEvaluator_getTextContent(
                                                 stream, resources, textState) {

      textState = textState || new TextState();

      var bidiTexts = [];
      var SPACE_FACTOR = 0.35;
      var MULTI_SPACE_FACTOR = 1.5;

      var self = this;
      var xref = this.xref;

      function handleSetFont(fontName, fontRef) {
        return self.fontTranslator.getLoadableFont(fontName, fontRef, xref,
                                                   resources, null);
      }

      resources = xref.fetchIfRef(resources) || new Dict();
      // The xobj is parsed iff it's needed, e.g. if there is a `DO` cmd.
      var xobjs = null;
      var xobjsCache = {};

      var preprocessor = new EvaluatorPreprocessor(stream, xref);
      var res = resources;

      var chunkBuf = [];
      var font = null;
      var charSpace = 0, wordSpace = 0;
      var operation;
      while ((operation = preprocessor.read())) {
          var fn = operation.fn;
          var args = operation.args;
          switch (fn) {
            // TODO: Add support for SAVE/RESTORE and XFORM here.
            case OPS.setFont:
              font = handleSetFont(args[0].name).translated;
              textState.fontSize = args[1];
              break;
            case OPS.setTextRise:
              textState.textRise = args[0];
              break;
            case OPS.setHScale:
              textState.textHScale = args[0] / 100;
              break;
            case OPS.setLeading:
              textState.leading = args[0];
              break;
            case OPS.moveText:
              textState.translateTextMatrix(args[0], args[1]);
              break;
            case OPS.setLeadingMoveText:
              textState.leading = -args[1];
              textState.translateTextMatrix(args[0], args[1]);
              break;
            case OPS.nextLine:
              textState.translateTextMatrix(0, -textState.leading);
              break;
            case OPS.setTextMatrix:
              textState.setTextMatrix(args[0], args[1],
                                       args[2], args[3], args[4], args[5]);
              break;
            case OPS.setCharSpacing:
              charSpace = args[0];
              break;
            case OPS.setWordSpacing:
              wordSpace = args[0];
              break;
            case OPS.beginText:
              textState.initialiseTextObj();
              break;
            case OPS.showSpacedText:
              var items = args[0];
              for (var j = 0, jj = items.length; j < jj; j++) {
                if (typeof items[j] === 'string') {
                  chunkBuf.push(fontCharsToUnicode(items[j], font));
                } else if (items[j] < 0 && font.spaceWidth > 0) {
                  var fakeSpaces = -items[j] / font.spaceWidth;
                  if (fakeSpaces > MULTI_SPACE_FACTOR) {
                    fakeSpaces = Math.round(fakeSpaces);
                    while (fakeSpaces--) {
                      chunkBuf.push(' ');
                    }
                  } else if (fakeSpaces > SPACE_FACTOR) {
                    chunkBuf.push(' ');
                  }
                }
              }
              break;
            case OPS.showText:
              chunkBuf.push(fontCharsToUnicode(args[0], font));
              break;
            case OPS.nextLineShowText:
              // For search, adding a extra white space for line breaks would be
              // better here, but that causes too much spaces in the
              // text-selection divs.
              chunkBuf.push(fontCharsToUnicode(args[0], font));
              break;
            case OPS.nextLineSetSpacingShowText:
              // Note comment in "'"
              chunkBuf.push(fontCharsToUnicode(args[2], font));
              break;
            case OPS.paintXObject:
              // Set the chunk such that the following if won't add something
              // to the state.
              chunkBuf.length = 0;

              if (args[0].code) {
                break;
              }

              if (!xobjs) {
                xobjs = resources.get('XObject') || new Dict();
              }

              var name = args[0].name;
              if (xobjsCache.key === name) {
                if (xobjsCache.texts) {
                  Util.concatenateToArray(bidiTexts, xobjsCache.texts);
                }
                break;
              }

              var xobj = xobjs.get(name);
              if (!xobj)
                break;
              assertWellFormed(isStream(xobj), 'XObject should be a stream');

              var type = xobj.dict.get('Subtype');
              assertWellFormed(
                isName(type),
                'XObject should have a Name subtype'
              );

              if ('Form' !== type.name) {
                xobjsCache.key = name;
                xobjsCache.texts = null;
                break;
              }

              var formTexts = this.getTextContent(
                xobj,
                xobj.dict.get('Resources') || resources,
                textState
              );
              xobjsCache.key = name;
              xobjsCache.texts = formTexts;
              Util.concatenateToArray(bidiTexts, formTexts);
              break;
            case OPS.setGState:
              var dictName = args[0];
              var extGState = resources.get('ExtGState');

              if (!isDict(extGState) || !extGState.has(dictName.name))
                break;

              var gsState = extGState.get(dictName.name);

              for (var i = 0; i < gsState.length; i++) {
                if (gsState[i] === 'Font') {
                  font = handleSetFont(args[0].name).translated;
                }
              }
              break;
          } // switch

          if (chunkBuf.length > 0) {
            var chunk = chunkBuf.join('');
            var bidiResult = PDFJS.bidi(chunk, -1, font.vertical);
            var bidiText = {
              str: bidiResult.str,
              dir: bidiResult.dir
            };
            var renderParams = textState.calcRenderParams(preprocessor.ctm);
            var fontHeight = textState.fontSize * renderParams.vScale;
            var fontAscent = font.ascent ? font.ascent * fontHeight :
              font.descent ? (1 + font.descent) * fontHeight : fontHeight;
            bidiText.x = renderParams.renderMatrix[4] - (fontAscent *
                           Math.sin(renderParams.angle));
            bidiText.y = renderParams.renderMatrix[5] + (fontAscent *
                           Math.cos(renderParams.angle));
            if (bidiText.dir == 'ttb') {
              bidiText.x += renderParams.vScale / 2;
              bidiText.y -= renderParams.vScale;
            }
            bidiText.angle = renderParams.angle;
            bidiText.size = fontHeight;
            bidiTexts.push(bidiText);

            chunkBuf.length = 0;
          }
      } // while

      return bidiTexts;
    }
  };

  return PartialEvaluator;
})();

var OperatorList = (function OperatorListClosure() {
  var CHUNK_SIZE = 1000;
  var CHUNK_SIZE_ABOUT = CHUNK_SIZE - 5; // close to chunk size

    function getTransfers(queue) {
      var transfers = [];
      var fnArray = queue.fnArray, argsArray = queue.argsArray;
      for (var i = 0, ii = queue.length; i < ii; i++) {
        switch (fnArray[i]) {
          case OPS.paintInlineImageXObject:
          case OPS.paintInlineImageXObjectGroup:
          case OPS.paintImageMaskXObject:
            var arg = argsArray[i][0]; // first param in imgData
            if (!arg.cached) {
              transfers.push(arg.data.buffer);
            }
            break;
        }
      }
      return transfers;
    }


    function OperatorList(intent, messageHandler, pageIndex) {
    this.messageHandler = messageHandler;
    // When there isn't a message handler the fn array needs to be able to grow
    // since we can't flush the operators.
    if (messageHandler) {
      this.fnArray = new Uint8Array(CHUNK_SIZE);
    } else {
      this.fnArray = [];
    }
    this.argsArray = [];
    this.dependencies = {};
    this.pageIndex = pageIndex;
    this.fnIndex = 0;
    this.intent = intent;
  }

  OperatorList.prototype = {

    get length() {
      return this.argsArray.length;
    },

    addOp: function(fn, args) {
      if (this.messageHandler) {
        this.fnArray[this.fnIndex++] = fn;
        this.argsArray.push(args);
        if (this.fnIndex >= CHUNK_SIZE) {
          this.flush();
        } else if (this.fnIndex >= CHUNK_SIZE_ABOUT &&
          (fn === OPS.restore || fn === OPS.endText)) {
          // heuristic to flush on boundary of restore or endText
          this.flush();
        }
      } else {
        this.fnArray.push(fn);
        this.argsArray.push(args);
      }
    },

    addDependency: function(dependency) {
      if (dependency in this.dependencies) {
        return;
      }
      this.dependencies[dependency] = true;
      this.addOp(OPS.dependency, [dependency]);
    },

    addDependencies: function(dependencies) {
      for (var key in dependencies) {
        this.addDependency(key);
      }
    },

    addOpList: function(opList) {
      Util.extendObj(this.dependencies, opList.dependencies);
      for (var i = 0, ii = opList.length; i < ii; i++) {
        this.addOp(opList.fnArray[i], opList.argsArray[i]);
      }
    },

    getIR: function() {
      return {
        fnArray: this.fnArray,
        argsArray: this.argsArray,
        length: this.length
      };
    },

    flush: function(lastChunk) {
      new QueueOptimizer().optimize(this);
      var transfers = getTransfers(this);
      this.messageHandler.send('RenderPageChunk', {
        operatorList: {
          fnArray: this.fnArray,
          argsArray: this.argsArray,
          lastChunk: lastChunk,
          length: this.length
        },
        pageIndex: this.pageIndex,
        intent: this.intent
      }, null, transfers);
      this.dependencies = [];
      this.fnIndex = 0;
      this.argsArray = [];
    }
  };

  return OperatorList;
})();

var TextState = (function TextStateClosure() {
  function TextState() {
    this.fontSize = 0;
    this.textMatrix = [1, 0, 0, 1, 0, 0];
    this.stateStack = [];
    //textState variables
    this.leading = 0;
    this.textHScale = 1;
    this.textRise = 0;
  }
  TextState.prototype = {
    initialiseTextObj: function TextState_initialiseTextObj() {
      var m = this.textMatrix;
      m[0] = 1; m[1] = 0; m[2] = 0; m[3] = 1; m[4] = 0; m[5] = 0;
    },
    setTextMatrix: function TextState_setTextMatrix(a, b, c, d, e, f) {
      var m = this.textMatrix;
      m[0] = a; m[1] = b; m[2] = c; m[3] = d; m[4] = e; m[5] = f;
    },
    translateTextMatrix: function TextState_translateTextMatrix(x, y) {
      var m = this.textMatrix;
      m[4] = m[0] * x + m[2] * y + m[4];
      m[5] = m[1] * x + m[3] * y + m[5];
    },
    calcRenderParams: function TextState_calcRenderingParams(cm) {
      var tm = this.textMatrix;
      var a = this.fontSize;
      var b = a * this.textHScale;
      var c = this.textRise;
      var vScale = Math.sqrt((tm[2] * tm[2]) + (tm[3] * tm[3]));
      var angle = Math.atan2(tm[1], tm[0]);
      var m0 = tm[0] * cm[0] + tm[1] * cm[2];
      var m1 = tm[0] * cm[1] + tm[1] * cm[3];
      var m2 = tm[2] * cm[0] + tm[3] * cm[2];
      var m3 = tm[2] * cm[1] + tm[3] * cm[3];
      var m4 = tm[4] * cm[0] + tm[5] * cm[2] + cm[4];
      var m5 = tm[4] * cm[1] + tm[5] * cm[3] + cm[5];
      var renderMatrix = [
        b * m0,
        b * m1,
        a * m2,
        a * m3,
        c * m2 + m4,
        c * m3 + m5
      ];
      return {
        renderMatrix: renderMatrix,
        vScale: vScale,
        angle: angle
      };
    }
  };
  return TextState;
})();

var EvalState = (function EvalStateClosure() {
  function EvalState() {
    this.font = null;
    this.textRenderingMode = TextRenderingMode.FILL;
  }
  EvalState.prototype = {
    clone: function CanvasExtraState_clone() {
      return Object.create(this);
    }
  };
  return EvalState;
})();

var EvaluatorPreprocessor = (function EvaluatorPreprocessor() {
  // Specifies properties for each command
  //
  // If variableArgs === true: [0, `numArgs`] expected
  // If variableArgs === false: exactly `numArgs` expected
  var OP_MAP = {
    // Graphic state
    w: { id: OPS.setLineWidth, numArgs: 1, variableArgs: false },
    J: { id: OPS.setLineCap, numArgs: 1, variableArgs: false },
    j: { id: OPS.setLineJoin, numArgs: 1, variableArgs: false },
    M: { id: OPS.setMiterLimit, numArgs: 1, variableArgs: false },
    d: { id: OPS.setDash, numArgs: 2, variableArgs: false },
    ri: { id: OPS.setRenderingIntent, numArgs: 1, variableArgs: false },
    i: { id: OPS.setFlatness, numArgs: 1, variableArgs: false },
    gs: { id: OPS.setGState, numArgs: 1, variableArgs: false },
    q: { id: OPS.save, numArgs: 0, variableArgs: false },
    Q: { id: OPS.restore, numArgs: 0, variableArgs: false },
    cm: { id: OPS.transform, numArgs: 6, variableArgs: false },

    // Path
    m: { id: OPS.moveTo, numArgs: 2, variableArgs: false },
    l: { id: OPS.lineTo, numArgs: 2, variableArgs: false },
    c: { id: OPS.curveTo, numArgs: 6, variableArgs: false },
    v: { id: OPS.curveTo2, numArgs: 4, variableArgs: false },
    y: { id: OPS.curveTo3, numArgs: 4, variableArgs: false },
    h: { id: OPS.closePath, numArgs: 0, variableArgs: false },
    re: { id: OPS.rectangle, numArgs: 4, variableArgs: false },
    S: { id: OPS.stroke, numArgs: 0, variableArgs: false },
    s: { id: OPS.closeStroke, numArgs: 0, variableArgs: false },
    f: { id: OPS.fill, numArgs: 0, variableArgs: false },
    F: { id: OPS.fill, numArgs: 0, variableArgs: false },
    'f*': { id: OPS.eoFill, numArgs: 0, variableArgs: false },
    B: { id: OPS.fillStroke, numArgs: 0, variableArgs: false },
    'B*': { id: OPS.eoFillStroke, numArgs: 0, variableArgs: false },
    b: { id: OPS.closeFillStroke, numArgs: 0, variableArgs: false },
    'b*': { id: OPS.closeEOFillStroke, numArgs: 0, variableArgs: false },
    n: { id: OPS.endPath, numArgs: 0, variableArgs: false },

    // Clipping
    W: { id: OPS.clip, numArgs: 0, variableArgs: false },
    'W*': { id: OPS.eoClip, numArgs: 0, variableArgs: false },

    // Text
    BT: { id: OPS.beginText, numArgs: 0, variableArgs: false },
    ET: { id: OPS.endText, numArgs: 0, variableArgs: false },
    Tc: { id: OPS.setCharSpacing, numArgs: 1, variableArgs: false },
    Tw: { id: OPS.setWordSpacing, numArgs: 1, variableArgs: false },
    Tz: { id: OPS.setHScale, numArgs: 1, variableArgs: false },
    TL: { id: OPS.setLeading, numArgs: 1, variableArgs: false },
    Tf: { id: OPS.setFont, numArgs: 2, variableArgs: false },
    Tr: { id: OPS.setTextRenderingMode, numArgs: 1, variableArgs: false },
    Ts: { id: OPS.setTextRise, numArgs: 1, variableArgs: false },
    Td: { id: OPS.moveText, numArgs: 2, variableArgs: false },
    TD: { id: OPS.setLeadingMoveText, numArgs: 2, variableArgs: false },
    Tm: { id: OPS.setTextMatrix, numArgs: 6, variableArgs: false },
    'T*': { id: OPS.nextLine, numArgs: 0, variableArgs: false },
    Tj: { id: OPS.showText, numArgs: 1, variableArgs: false },
    TJ: { id: OPS.showSpacedText, numArgs: 1, variableArgs: false },
    '\'': { id: OPS.nextLineShowText, numArgs: 1, variableArgs: false },
    '"': { id: OPS.nextLineSetSpacingShowText, numArgs: 3,
      variableArgs: false },

    // Type3 fonts
    d0: { id: OPS.setCharWidth, numArgs: 2, variableArgs: false },
    d1: { id: OPS.setCharWidthAndBounds, numArgs: 6, variableArgs: false },

    // Color
    CS: { id: OPS.setStrokeColorSpace, numArgs: 1, variableArgs: false },
    cs: { id: OPS.setFillColorSpace, numArgs: 1, variableArgs: false },
    SC: { id: OPS.setStrokeColor, numArgs: 4, variableArgs: true },
    SCN: { id: OPS.setStrokeColorN, numArgs: 33, variableArgs: true },
    sc: { id: OPS.setFillColor, numArgs: 4, variableArgs: true },
    scn: { id: OPS.setFillColorN, numArgs: 33, variableArgs: true },
    G: { id: OPS.setStrokeGray, numArgs: 1, variableArgs: false },
    g: { id: OPS.setFillGray, numArgs: 1, variableArgs: false },
    RG: { id: OPS.setStrokeRGBColor, numArgs: 3, variableArgs: false },
    rg: { id: OPS.setFillRGBColor, numArgs: 3, variableArgs: false },
    K: { id: OPS.setStrokeCMYKColor, numArgs: 4, variableArgs: false },
    k: { id: OPS.setFillCMYKColor, numArgs: 4, variableArgs: false },

    // Shading
    sh: { id: OPS.shadingFill, numArgs: 1, variableArgs: false },

    // Images
    BI: { id: OPS.beginInlineImage, numArgs: 0, variableArgs: false },
    ID: { id: OPS.beginImageData, numArgs: 0, variableArgs: false },
    EI: { id: OPS.endInlineImage, numArgs: 1, variableArgs: false },

    // XObjects
    Do: { id: OPS.paintXObject, numArgs: 1, variableArgs: false },
    MP: { id: OPS.markPoint, numArgs: 1, variableArgs: false },
    DP: { id: OPS.markPointProps, numArgs: 2, variableArgs: false },
    BMC: { id: OPS.beginMarkedContent, numArgs: 1, variableArgs: false },
    BDC: { id: OPS.beginMarkedContentProps, numArgs: 2,
      variableArgs: false },
    EMC: { id: OPS.endMarkedContent, numArgs: 0, variableArgs: false },

    // Compatibility
    BX: { id: OPS.beginCompat, numArgs: 0, variableArgs: false },
    EX: { id: OPS.endCompat, numArgs: 0, variableArgs: false },

    // (reserved partial commands for the lexer)
    BM: null,
    BD: null,
    'true': null,
    fa: null,
    fal: null,
    fals: null,
    'false': null,
    nu: null,
    nul: null,
    'null': null
  };

  function EvaluatorPreprocessor(stream, xref) {
    // TODO(mduan): pass array of knownCommands rather than OP_MAP
    // dictionary
    this.parser = new Parser(new Lexer(stream, OP_MAP), false, xref);
    this.ctm = new Float32Array([1, 0, 0, 1, 0, 0]);
    this.savedStates = [];
  }
  EvaluatorPreprocessor.prototype = {
    get savedStatesDepth() {
      return this.savedStates.length;
    },
    read: function EvaluatorPreprocessor_read() {
      var args = [];
      while (true) {
        var obj = this.parser.getObj();
        if (isEOF(obj)) {
          return null; // no more commands
        }
        if (!isCmd(obj)) {
          // argument
          if (obj !== null && obj !== undefined) {
            args.push(obj instanceof Dict ? obj.getAll() : obj);
            assertWellFormed(args.length <= 33, 'Too many arguments');
          }
          continue;
        }

        var cmd = obj.cmd;
        // Check that the command is valid
        var opSpec = OP_MAP[cmd];
        if (!opSpec) {
          warn('Unknown command "' + cmd + '"');
          continue;
        }

        var fn = opSpec.id;

        // Validate the number of arguments for the command
        if (opSpec.variableArgs) {
          if (args.length > opSpec.numArgs) {
            info('Command ' + fn + ': expected [0,' + opSpec.numArgs +
              '] args, but received ' + args.length + ' args');
          }
        } else {
          if (args.length < opSpec.numArgs) {
            // If we receive too few args, it's not possible to possible
            // to execute the command, so skip the command
            info('Command ' + fn + ': because expected ' +
              opSpec.numArgs + ' args, but received ' + args.length +
              ' args; skipping');
            args = [];
            continue;
          } else if (args.length > opSpec.numArgs) {
            info('Command ' + fn + ': expected ' + opSpec.numArgs +
              ' args, but received ' + args.length + ' args');
          }
        }

        // TODO figure out how to type-check vararg functions

        this.preprocessCommand(fn, args);

        return {fn: fn, args: args};
      }
    },
    getState: function EvaluatorPreprocessor_getState() {
      return {
        ctm: this.ctm
      };
    },
    setState: function EvaluatorPreprocessor_setState(state) {
      this.ctm = state.ctm;
    },
    preprocessCommand: function EvaluatorPreprocessor_preprocessCommand(fn,
                                                                        args) {
      switch (fn | 0) {
        case OPS.save:
          this.savedStates.push(this.getState());
          break;
        case OPS.restore:
          var previousState = this.savedStates.pop();
          if (previousState) {
            this.setState(previousState);
          }
          break;
        case OPS.transform:
          var ctm = this.ctm;
          var m = new Float32Array(6);
          m[0] = ctm[0] * args[0] + ctm[2] * args[1];
          m[1] = ctm[1] * args[0] + ctm[3] * args[1];
          m[2] = ctm[0] * args[2] + ctm[2] * args[3];
          m[3] = ctm[1] * args[2] + ctm[3] * args[3];
          m[4] = ctm[0] * args[4] + ctm[2] * args[5] + ctm[4];
          m[5] = ctm[1] * args[4] + ctm[3] * args[5] + ctm[5];
          this.ctm = m;
          break;
      }
    }
  };
  return EvaluatorPreprocessor;
})();

var QueueOptimizer = (function QueueOptimizerClosure() {
  function squash(array, index, howMany, element) {
    if (isArray(array)) {
      array.splice(index, howMany, element);
    } else if (typeof element !== 'undefined') {
      // Replace the element.
      array[index] = element;
      // Shift everything after the element up.
      var sub = array.subarray(index + howMany);
      array.set(sub, index + 1);
    } else {
      // Shift everything after the element up.
      var sub = array.subarray(index + howMany);
      array.set(sub, index);
    }
  }

  function addState(parentState, pattern, fn) {
    var state = parentState;
    for (var i = 0, ii = pattern.length - 1; i < ii; i++) {
      var item = pattern[i];
      state = state[item] || (state[item] = []);
    }
    state[pattern[pattern.length - 1]] = fn;
  }

  var InitialState = [];

  addState(InitialState,
    [OPS.save, OPS.transform, OPS.paintInlineImageXObject, OPS.restore],
    function foundInlineImageGroup(context) {
      // grouping paintInlineImageXObject's into paintInlineImageXObjectGroup
      // searching for (save, transform, paintInlineImageXObject, restore)+
      var MIN_IMAGES_IN_INLINE_IMAGES_BLOCK = 10;
      var MAX_IMAGES_IN_INLINE_IMAGES_BLOCK = 200;
      var MAX_WIDTH = 1000;
      var IMAGE_PADDING = 1;

      var fnArray = context.fnArray, argsArray = context.argsArray;
      var j = context.currentOperation - 3, i = j + 4;
      var ii = context.operationsLength;

      for (; i < ii && fnArray[i - 4] === fnArray[i]; i++) {
      }
      var count = Math.min((i - j) >> 2, MAX_IMAGES_IN_INLINE_IMAGES_BLOCK);
      if (count < MIN_IMAGES_IN_INLINE_IMAGES_BLOCK) {
        context.currentOperation = i - 1;
        return;
      }
      // assuming that heights of those image is too small (~1 pixel)
      // packing as much as possible by lines
      var maxX = 0;
      var map = [], maxLineHeight = 0;
      var currentX = IMAGE_PADDING, currentY = IMAGE_PADDING;
      for (var q = 0; q < count; q++) {
        var transform = argsArray[j + (q << 2) + 1];
        var img = argsArray[j + (q << 2) + 2][0];
        if (currentX + img.width > MAX_WIDTH) {
          // starting new line
          maxX = Math.max(maxX, currentX);
          currentY += maxLineHeight + 2 * IMAGE_PADDING;
          currentX = 0;
          maxLineHeight = 0;
        }
        map.push({
          transform: transform,
          x: currentX, y: currentY,
          w: img.width, h: img.height
        });
        currentX += img.width + 2 * IMAGE_PADDING;
        maxLineHeight = Math.max(maxLineHeight, img.height);
      }
      var imgWidth = Math.max(maxX, currentX) + IMAGE_PADDING;
      var imgHeight = currentY + maxLineHeight + IMAGE_PADDING;
      var imgData = new Uint8Array(imgWidth * imgHeight * 4);
      var imgRowSize = imgWidth << 2;
      for (var q = 0; q < count; q++) {
        var data = argsArray[j + (q << 2) + 2][0].data;
        // copy image by lines and extends pixels into padding
        var rowSize = map[q].w << 2;
        var dataOffset = 0;
        var offset = (map[q].x + map[q].y * imgWidth) << 2;
        imgData.set(
          data.subarray(0, rowSize), offset - imgRowSize);
        for (var k = 0, kk = map[q].h; k < kk; k++) {
          imgData.set(
            data.subarray(dataOffset, dataOffset + rowSize), offset);
          dataOffset += rowSize;
          offset += imgRowSize;
        }
        imgData.set(
          data.subarray(dataOffset - rowSize, dataOffset), offset);
        while (offset >= 0) {
          data[offset - 4] = data[offset];
          data[offset - 3] = data[offset + 1];
          data[offset - 2] = data[offset + 2];
          data[offset - 1] = data[offset + 3];
          data[offset + rowSize] = data[offset + rowSize - 4];
          data[offset + rowSize + 1] = data[offset + rowSize - 3];
          data[offset + rowSize + 2] = data[offset + rowSize - 2];
          data[offset + rowSize + 3] = data[offset + rowSize - 1];
          offset -= imgRowSize;
        }
      }
      // replacing queue items
      squash(fnArray, j, count * 4, OPS.paintInlineImageXObjectGroup);
      argsArray.splice(j, count * 4,
        [{width: imgWidth, height: imgHeight, kind: ImageKind.RGBA_32BPP,
          data: imgData}, map]);
      context.currentOperation = j;
      context.operationsLength -= count * 4 - 1;
    });

  addState(InitialState,
    [OPS.save, OPS.transform, OPS.paintImageMaskXObject, OPS.restore],
    function foundImageMaskGroup(context) {
      // grouping paintImageMaskXObject's into paintImageMaskXObjectGroup
      // searching for (save, transform, paintImageMaskXObject, restore)+
      var MIN_IMAGES_IN_MASKS_BLOCK = 10;
      var MAX_IMAGES_IN_MASKS_BLOCK = 100;
      var MAX_SAME_IMAGES_IN_MASKS_BLOCK = 1000;

      var fnArray = context.fnArray, argsArray = context.argsArray;
      var j = context.currentOperation - 3, i = j + 4;
      var ii = context.operationsLength;

      for (; i < ii && fnArray[i - 4] === fnArray[i]; i++) {
      }
      var count = (i - j) >> 2;
      if (count < MIN_IMAGES_IN_MASKS_BLOCK) {
        context.currentOperation = i - 1;
        return;
      }

      var isSameImage = false;
      if (argsArray[j + 1][1] === 0 && argsArray[j + 1][2] === 0) {
        i = j + 4;
        isSameImage = true;
        for (var q = 1; q < count; q++, i += 4) {
          var prevTransformArgs = argsArray[i - 3];
          var transformArgs = argsArray[i + 1];
          if (argsArray[i - 2][0] !== argsArray[i + 2][0] ||
              prevTransformArgs[0] !== transformArgs[0] ||
              prevTransformArgs[1] !== transformArgs[1] ||
              prevTransformArgs[2] !== transformArgs[2] ||
              prevTransformArgs[3] !== transformArgs[3]) {
            if (q < MIN_IMAGES_IN_MASKS_BLOCK) {
              isSameImage = false;
            } else {
              count = q;
            }
            break; // different image or transform
          }
        }
      }

      if (isSameImage) {
        count = Math.min(count, MAX_SAME_IMAGES_IN_MASKS_BLOCK);
        var positions = new Float32Array(count * 2);
        i = j + 1;
        for (var q = 0; q < count; q++) {
          var transformArgs = argsArray[i];
          positions[(q << 1)] = transformArgs[4];
          positions[(q << 1) + 1] = transformArgs[5];
          i += 4;
        }

        // replacing queue items
        squash(fnArray, j, count * 4, OPS.paintImageMaskXObjectRepeat);
        argsArray.splice(j, count * 4, [argsArray[j + 2][0],
          argsArray[j + 1][0], argsArray[j + 1][3], positions]);

        context.currentOperation = j;
        context.operationsLength -= count * 4 - 1;
      } else {
        count = Math.min(count, MAX_IMAGES_IN_MASKS_BLOCK);
        var images = [];
        for (var q = 0; q < count; q++) {
          var transformArgs = argsArray[j + (q << 2) + 1];
          var maskParams = argsArray[j + (q << 2) + 2][0];
          images.push({data: maskParams.data, width: maskParams.width,
            height: maskParams.height, transform: transformArgs});
        }

        // replacing queue items
        squash(fnArray, j, count * 4, OPS.paintImageMaskXObjectGroup);
        argsArray.splice(j, count * 4, [images]);

        context.currentOperation = j;
        context.operationsLength -= count * 4 - 1;
      }
    });

  addState(InitialState,
    [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
    function (context) {
      var MIN_IMAGES_IN_BLOCK = 3;
      var MAX_IMAGES_IN_BLOCK = 1000;

      var fnArray = context.fnArray, argsArray = context.argsArray;
      var j = context.currentOperation - 3, i = j + 4;
      if (argsArray[j + 1][1] !== 0 || argsArray[j + 1][2] !== 0) {
        return;
      }
      var ii = context.operationsLength;
      for (; i + 3 < ii && fnArray[i - 4] === fnArray[i]; i += 4) {
        if (fnArray[i - 3] !== fnArray[i + 1] ||
            fnArray[i - 2] !== fnArray[i + 2] ||
            fnArray[i - 1] !== fnArray[i + 3]) {
          break;
        }
        if (argsArray[i - 2][0] !== argsArray[i + 2][0]) {
          break; // different image
        }
        var prevTransformArgs = argsArray[i - 3];
        var transformArgs = argsArray[i + 1];
        if (prevTransformArgs[0] !== transformArgs[0] ||
            prevTransformArgs[1] !== transformArgs[1] ||
            prevTransformArgs[2] !== transformArgs[2] ||
            prevTransformArgs[3] !== transformArgs[3]) {
          break; // different transform
        }
      }
      var count = Math.min((i - j) >> 2, MAX_IMAGES_IN_BLOCK);
      if (count < MIN_IMAGES_IN_BLOCK) {
        context.currentOperation = i - 1;
        return;
      }

      var positions = new Float32Array(count * 2);
      i = j + 1;
      for (var q = 0; q < count; q++) {
        var transformArgs = argsArray[i];
        positions[(q << 1)] = transformArgs[4];
        positions[(q << 1) + 1] = transformArgs[5];
        i += 4;
      }
      var args = [argsArray[j + 2][0], argsArray[j + 1][0],
        argsArray[j + 1][3], positions];
      // replacing queue items
      squash(fnArray, j, count * 4, OPS.paintImageXObjectRepeat);
      argsArray.splice(j, count * 4, args);

      context.currentOperation = j;
      context.operationsLength -= count * 4 - 1;
    });

  addState(InitialState,
    [OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText],
    function (context) {
      // moving single chars with same font into beginText/endText groups
      // searching for (beginText, setFont, setTextMatrix, showText, endText)+
      var MIN_CHARS_IN_BLOCK = 3;
      var MAX_CHARS_IN_BLOCK = 1000;

      var fnArray = context.fnArray, argsArray = context.argsArray;
      var j = context.currentOperation - 4, i = j + 5;
      var ii = context.operationsLength;

      for (; i < ii && fnArray[i - 5] === fnArray[i]; i++) {
        if (fnArray[i] === OPS.setFont) {
          if (argsArray[i - 5][0] !== argsArray[i][0] ||
            argsArray[i - 5][1] !== argsArray[i][1]) {
            break;
          }
        }
      }
      var count = Math.min(((i - j) / 5) | 0, MAX_CHARS_IN_BLOCK);
      if (count < MIN_CHARS_IN_BLOCK) {
        context.currentOperation = i - 1;
        return;
      }
      if (j >= 4 && fnArray[j - 4] === fnArray[j + 1] &&
        fnArray[j - 3] === fnArray[j + 2] &&
        fnArray[j - 2] === fnArray[j + 3] &&
        fnArray[j - 1] === fnArray[j + 4] &&
        argsArray[j - 4][0] === argsArray[j + 1][0] &&
        argsArray[j - 4][1] === argsArray[j + 1][1]) {
        // extending one block ahead (very first block might have 'dependency')
        count++;
        j -= 5;
      }
      var k = j + 7;
      i = j + 4;
      for (var q = 1; q < count; q++) {
        fnArray[i] = fnArray[k];
        argsArray[i] = argsArray[k];
        fnArray[i + 1] = fnArray[k + 1];
        argsArray[i + 1] = argsArray[k + 1];
        i += 2;
        k += 5;
      }
      var removed = (count - 1) * 3;
      squash(fnArray, i, removed);
      argsArray.splice(i, removed);

      context.currentOperation = i;
      context.operationsLength -= removed;

    });

  function QueueOptimizer() {
  }
  QueueOptimizer.prototype = {
    optimize: function QueueOptimizer_optimize(queue) {
      var fnArray = queue.fnArray, argsArray = queue.argsArray;
      var context = {
        currentOperation: 0,
        operationsLength: argsArray.length,
        fnArray: fnArray,
        argsArray: argsArray
      };
      var i, ii = argsArray.length;
      var state;
      for (i = 0; i < ii; i++) {
        state = (state || InitialState)[fnArray[i]];
        if (typeof state === 'function') { // we found some handler
          context.currentOperation = i;
          state = state(context);
          i = context.currentOperation;
          ii = context.operationsLength;
        }
      }
    }
  };
  return QueueOptimizer;
})();
