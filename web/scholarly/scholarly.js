import {getColor, getMode, initUI, sendEvent, setMode} from "./ui.js";
import {getTextColor, removeEyeCancer} from "./color_utils.js";
import {getFilter} from "./filter.js";
import {getProfilePictureURL} from "./profile_pictures.js";

var highlights = [];
var stickyNotes = [];
let es;
let stickyNoteCounter = 1;
let stickyNoteId = 1;

let initializedPages = new Set();
let pages = new Map();

export function init(app) {
  initUI();

  app.eventBus.on("pagerendered", function (event) {
    if (event.cssTransform) {
      return;
    }

    let page = event.pageNumber;
    let canvas = event.source.canvas;
    pages.set(page, {
      canvasElement: canvas,
      pageElement: canvas.parentElement.parentElement
    });

    initAnnotations();
    drawAnnotations(event);
    createHighlight(page);
    createStickyNote(page);
    initializedPages.add(page);
  });
}

function getProfilePicture(userId) {
  return window.scholarlyUsers?.get(userId)?.profilePicture
    ?? "https://lh3.googleusercontent.com/a/AItbvmlrh0nzdNs8foIotTu6O-3JN6XvLvLRuKyYosp3=s96-c";
}

function initAnnotations() {
  // Loads the existing annotations into the highlights / stickyNotes array.
  for (let annotation of window.scholarlyAnnotations) {
    if (annotation.type === "highlight") {
      highlights.push({
        id: annotation.id,
        collectionId: null,
        page: annotation.page,
        relPos: {x: annotation.startPosition.x, y: annotation.startPosition.y},
        relSize: {
          width: Math.abs(
            annotation.startPosition.x - annotation.endPosition.x),
          height: Math.abs(
            annotation.startPosition.y - annotation.endPosition.y)
        },
        color: annotation.color
      });
    } else if (annotation.type === "stickyNote") {
      stickyNotes.push({
        id: annotation.id,
        ownerId: annotation.ownerId,
        collectionId: null,
        stickyNoteId,
        page: annotation.page,
        relPos: {x: annotation.position.x, y: annotation.position.y},
        color: annotation.color,
        content: annotation.content
      });
      stickyNoteId++;
    } else {
      console.error(`unknown annotation type "${annotation.type}"`);
    }
  }
}

/**
 * Called every time an annotation is created.
 *
 * @param annotation
 * @param callback
 */
function sendAnnotation(annotation, callback = null) {
  sendEvent("newAnnotation", [annotation, callback]);
}

function deleteAnnotation(id) {
  sendEvent("deleteAnnotation", id);
}

function createHighlight(page) {
  let preview;
  let relX;
  let relY;

  function mouseDownListener(e) {
    if (getMode() !== "highlight") {
      return;
    }

    if (e === undefined) {
      console.log("UNDEFINED");
    }

    es = e;
    startDrag(e);
    disableSelect(e);

    let {canvasElement, pageElement} = pages.get(page);
    let bb = canvasElement.getBoundingClientRect();
    relX = (e.x - bb.left) / bb.width;
    relY = (e.y - bb.top) / bb.height;
    preview = document.createElement("div");
    preview.style.position = "absolute";
    preview.style.left = (e.x - bb.left) + "px";
    preview.style.top = (e.y - bb.top) + "px";
    preview.style.backgroundColor = getColor();
    preview.style.opacity = "0.2";

    if (pageElement != null) {
      pageElement.querySelector(".annotationEditorLayer").appendChild(preview);
    }
  }

  function mouseMoveListener(e) {
    if (getMode() !== "highlight" || preview == null) {
      return;
    }

    let {canvasElement, pageElement} = pages.get(page);
    let bb = canvasElement.getBoundingClientRect();
    let endRelX = (e.x - bb.left) / bb.width;
    let endRelY = (e.y - bb.top) / bb.height;
    let relWidth = endRelX - relX;
    let relHeight = endRelY - relY;
    let absWidth = relWidth * bb.width;
    let absHeight = relHeight * bb.height;
    preview.style.width = Math.abs(absWidth) + "px";
    preview.style.height = Math.abs(absHeight) + "px";

    if (absWidth < 0) {
      preview.style.left = (e.x - bb.left) + "px";
    } else {
      preview.style.left = (relX * bb.width) + "px";
    }

    if (absHeight < 0) {
      preview.style.top = (e.y - bb.top) + "px";
    } else {
      preview.style.top = (relY * bb.height) + "px";
    }
  }

  function mouseUpListener(e) {
    if (getMode() !== "highlight") {
      return;
    }

    onDragEnd();
    let {canvasElement, pageElement} = pages.get(page);
    let bb = canvasElement.getBoundingClientRect();
    let relX = (es.x - bb.left) / bb.width;
    let relY = (es.y - bb.top) / bb.height;
    let relW = (e.x - es.x) / bb.width;
    let relH = (e.y - es.y) / bb.height;
    let color = getColor();
    renderRect(canvasElement, relX, relY, relW, relH, color);

    let highlight = {
      collectionId: null,
      page,
      relPos: {x: relX, y: relY},
      relSize: {width: relW, height: relH},
      color
    };
    highlights.push(highlight);

    sendAnnotation({
      collectionId: null,
      color,
      page,
      startPosition: {x: relX, y: relY},
      endPosition: {x: relX + relW, y: relY + relH},
      type: "highlight",
    }, (id) => highlight.id = id);

    preview = null;

    if (pageElement != null) {
      pageElement.querySelector(".annotationEditorLayer").innerHTML = "";
    }
  }

  if (!initializedPages.has(page)) {
    let pageElement = pages.get(page).pageElement;
    pageElement.addEventListener("mousedown", mouseDownListener);
    pageElement.addEventListener("mousemove", mouseMoveListener);
    pageElement.addEventListener("mouseup", mouseUpListener);
  }
}

function createStickyNote(page) {
  function mouseClickListener(e) {
    if (getMode() !== "stickyNote") {
      return;
    }

    if (e.y < page.y || e.y > page.y + page.height) {
      return;
    }

    let {canvasElement} = pages.get(page);
    let bb = canvasElement.getBoundingClientRect();
    let relX = (e.x - bb.left) / bb.width;
    let relY = (e.y - bb.top) / bb.height;
    let color = getColor();
    let content = null;

    let thisStickyNoteId = stickyNoteId;
    stickyNoteId++;

    stickyNotes.push({
      ownerId: window.scholarlyUserId,
      collectionId: null,
      stickyNoteId: thisStickyNoteId,
      page,
      relPos: {x: relX, y: relY},
      color,
      content
    });

    getProfilePictureURL(window.scholarlyUserId)
    .then(url => renderNote(thisStickyNoteId, page, relX, relY, color, content,
      url))

    stickyNoteId++;

    setMode('none');
  }

  let {pageElement} = pages.get(page);
  pageElement.addEventListener("click", mouseClickListener);
}

function drawAnnotations(event) {
  if (getFilter() == null) {
    return;
  }

  for (let element of highlights) {
    if (getFilter().length === 0 && element.collectionId != null) {
      continue;
    }

    if (element.collectionId != null && !getFilter().includes(
      element.collectionId)) {
      continue;
    }

    if (element.page === event.pageNumber) {
      renderHighlight(event.pageNumber, element.relPos, element.relSize,
        element.color);
    }
  }

  for (let element of stickyNotes) {
    if (getFilter().length === 0 && element.collectionId != null) {
      continue;
    }

    if (element.collectionId != null && !getFilter().includes(
      element.collectionId)) {
      continue;
    }

    if (element.page === event.pageNumber) {
      getProfilePictureURL(element.ownerId).then(url => {
        renderStickyNote(element.stickyNoteId, event.pageNumber,
          element.relPos, element.content, element.color, url);
      })
    }
  }
}

function renderRect(canvas, relX, relY, relW, relH, color) {
  let ctx = canvas.getContext('2d');

  let absX = canvas.width * relX;
  let absY = canvas.height * relY;
  let absW = canvas.width * relW;
  let absH = canvas.height * relH;

  ctx.fillStyle = color;
  ctx.globalAlpha = 0.2;
  ctx.fillRect(absX, absY, absW, absH);
}

function renderNote(stickyNoteId, page, relX, relY, color, content,
  profilePictureURL) {
  let {canvasElement, pageElement} = pages.get(page);
  color = removeEyeCancer(color);
  let textColor = getTextColor(color);
  let idSave = "StickyNoteSave" + stickyNoteCounter;
  let idDelete = "StickyNoteDelete" + stickyNoteCounter;
  let idEdit = "StickyNoteEdit" + stickyNoteCounter;
  let idSpanEdit = "noteEdit" + stickyNoteCounter;
  let idSpanDisplay = "noteDisplay" + stickyNoteCounter;
  stickyNoteCounter++;

  let spanEdit = document.createElement("div");
  spanEdit.innerHTML =
    `<div class="stickynote-wrapper" id="${idSpanEdit}">\n`
    + `  <div class="stickynote-content" style="background-color: ${color}"'>\n`
    + `    <textarea placeholder="Add a sticky note" style="color: ${textColor}"></textarea>\n`
    + `    <button id="${idSave}" >Save</button>\n`
    + '  </div>\n'
    + '\n'
    + '  <img src="' + profilePictureURL + '" referrerpolicy="no-referrer"/>\n'
    + '</div>'
  let bb = canvasElement.getBoundingClientRect();
  spanEdit.style.position = "absolute";
  spanEdit.style.top = (relY * bb.height) + "px";
  spanEdit.style.left = (relX * bb.width) + "px";
  pageElement.appendChild(spanEdit);

  let spanDisplay = document.createElement("div");
  spanDisplay.setAttribute("id", idSpanDisplay);
  spanDisplay.setAttribute("class", "stickynote-wrapper");

  spanDisplay.innerHTML =
    `  <div class="stickynote-content" style="background-color: ${color}; color: ${textColor}">\n`
    + `    <div style="top: 6px" id="${idDelete}">\n`
    + '      <svg style="width:20px;height:20px" viewBox="0 0 24 24">\n'
    + '        <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" />\n'
    + '      </svg>\n'
    + '    </div>\n'
    + `    <div style="top: 30px" id="${idEdit}">\n`
    + '      <svg style="width:20px;height:20px" viewBox="0 0 24 24">\n'
    + '        <path fill="currentColor" d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z" />\n'
    + '      </svg>\n'
    + '    </div>\n'
    + '    <p>\n'
    + `${content}`
    + '    </p>\n'
    + '  </div>\n'
    + '  <img src="' + profilePictureURL + '" referrerpolicy="no-referrer" />\n'
  spanDisplay.style.position = "absolute";
  spanDisplay.style.top = (relY * bb.height) + "px";
  spanDisplay.style.left = (relX * bb.width) + "px";
  pageElement.appendChild(spanDisplay);

  if (content == null) {
    spanDisplay.hidden = true;
  } else {
    spanEdit.hidden = true;
    document.querySelector(
      `.stickynote-wrapper#${idSpanEdit} > div > textarea`).value = content;
    document.querySelector(
      `.stickynote-wrapper#${idSpanDisplay} > div > p`).innerText = content;
  }

  document.getElementById(idDelete).addEventListener("click", (e) => {
    pageElement.removeChild(spanDisplay);
    pageElement.removeChild(spanEdit);

    let stickyNote = stickyNotes.find(s => stickyNoteId === s.stickyNoteId);

    for (var i = 0; i < stickyNotes.length; i++) {
      if (stickyNotes[i].stickyNoteId === stickyNoteId) {
        stickyNotes.splice(i, 1);
      }
    }

    deleteAnnotation(stickyNote.id);
  });

  document.getElementById(idEdit).addEventListener("click", (e) => {
    spanDisplay.hidden = true;
    spanEdit.hidden = false;
  });

  document.getElementById(idSave).addEventListener("click", (e) => {
    let textField = document.querySelector(
      `.stickynote-wrapper#${idSpanEdit} > div > textarea`);
    let paragraph = document.querySelector(
      `.stickynote-wrapper#${idSpanDisplay} > div > p`);
    spanEdit.hidden = true;
    spanDisplay.hidden = false;
    paragraph.innerText = textField.value;

    let stickyNote = stickyNotes.find(s => s.stickyNoteId === stickyNoteId);
    stickyNote.content = textField.value;

    sendAnnotation({
      collectionId: stickyNote.collectionId,
      content: stickyNote.content,
      color: stickyNote.color,
      page: stickyNote.page,
      position: {x: stickyNote.relPos.x, y: stickyNote.relPos.y},
      type: "stickyNote"
    }, (id) => stickyNote.id = id);
  });
}

function disableSelect(event) {
  event.preventDefault();
}

function startDrag(event) {
  window.addEventListener('mouseup', onDragEnd);
  window.addEventListener('selectstart', disableSelect);
}

function onDragEnd() {
  window.removeEventListener('mouseup', onDragEnd);
  window.removeEventListener('selectstart', disableSelect);
}

function renderStickyNote(stickyNoteId, page, relPos, content, color,
  profilePictureURL) {
  renderNote(stickyNoteId, page, relPos.x, relPos.y, color, content,
    profilePictureURL);
}

function renderHighlight(page, relPos, relSize, color) {
  let {canvasElement} = pages.get(page);
  renderRect(canvasElement, relPos.x, relPos.y, relSize.width, relSize.height,
    color);
}
