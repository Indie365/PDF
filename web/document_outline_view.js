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
/* globals PDFView */

'use strict';

var DocumentOutlineView = function documentOutlineView(outline) {
  var outlineView = document.getElementById('outlineView');
  var outlineButton = document.getElementById('viewOutline');
  while (outlineView.firstChild)
    outlineView.removeChild(outlineView.firstChild);

  if (!outline) {
    if (!outlineView.classList.contains('hidden')) {
      PDFView.switchSidebarView('thumbs');
    }
    return;
  }

  function bindItemLink(domObj, item) {
    domObj.href = PDFView.getDestinationHash(item.dest);
    domObj.onclick = function documentOutlineViewOnclick(e) {
      PDFView.navigateTo(item.dest);
      return false;
    };
  }

  var queue = [{parent: outlineView, items: outline}];
  while (queue.length > 0) {
    var levelData = queue.shift();
    var i, n = levelData.items.length;
    for (i = 0; i < n; i++) {
      var item = levelData.items[i];
      var ul = document.createElement('ul');
      var li = document.createElement('li');
      ul.appendChild(li);
      var a = document.createElement('a');
      bindItemLink(a, item);
      a.textContent = item.title;
      li.appendChild(a);

      if (item.items.length > 0) {
        var subItems = document.createElement('ul');
        ul.appendChild(subItems);
        // ul.className = 'collapsed';
        // li.nextSibling.classList.add('hidden');
        ul.className = 'expanded';
        queue.push({parent: subItems, items: item.items});
      }

      levelData.parent.appendChild(ul);
    }
  }
};
