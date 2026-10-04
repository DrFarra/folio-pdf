/* MuPDF 1.28.1 native MuJS: mutool run verify-native-export.js exported.pdf
 * ES5 only. Opening a filename uses the native, seekable file stream, including
 * xref offsets beyond 2 GiB. Only the fixture's two tiny appearance streams are
 * decoded here; the complete PDF is never read into a JavaScript buffer.
 * Source-prefix preservation is checked separately by native-smoke-ios.py.
 */
(function () {
    "use strict";

    function assert(condition, message) {
        if (!condition) throw new Error(message);
    }
    function required(value, message) {
        assert(value !== null && value !== undefined && !value.isNull(), message);
        return value;
    }
    function get(object, key, message) {
        return required(object.get(key), message || ("Missing PDF key: " + key));
    }
    function string(object, key) {
        var value = get(object, key);
        assert(value.isString(), key + " must be a PDF string.");
        return value.asString();
    }
    function name(object, key) {
        var value = get(object, key);
        assert(value.isName(), key + " must be a PDF name.");
        return value.asName();
    }
    function number(value, label) {
        required(value, "Missing " + label);
        assert(value.isNumber(), label + " must be numeric.");
        // MuJS's PDFObject.asNumber() uses pdf_to_int for integer objects.
        // Parsing the small scalar's representation preserves 64-bit /Prev.
        var result = Number(value.toString());
        assert(isFinite(result), label + " must be finite.");
        return result;
    }
    function values(object, label) {
        required(object, "Missing " + label);
        assert(object.isArray(), label + " must be an array.");
        var result = [];
        object.forEach(function (value) { result.push(value); });
        return result;
    }
    function numbers(object, label) {
        return values(object, label).map(function (value) { return number(value, label); });
    }
    function near(actual, expected, label) {
        assert(Math.abs(actual - expected) < 0.001, label + ": expected " + expected + ", got " + actual);
    }
    function arrayNear(actual, expected, label) {
        assert(actual.length === expected.length, label + " length changed.");
        for (var i = 0; i < actual.length; ++i) near(actual[i], expected[i], label + "[" + i + "]");
    }
    function checkArray(object, key, expected, label) {
        arrayNear(numbers(get(object, key), key), expected, label || key);
    }
    function opacity(object) {
        var alpha = object.get("CA");
        return alpha === null || alpha.isNull() ? 1 : number(alpha, "CA");
    }
    function namedAnnotation(objects, expectedName) {
        var matches = objects.filter(function (object) {
            var value = object.get("NM");
            return value !== null && value.isString() && value.asString() === expectedName;
        });
        assert(matches.length === 1, "Expected exactly one live annotation named " + expectedName + ".");
        return matches[0];
    }
    function appearance(object, expectedStream, expectedBox, label) {
        var stream = get(get(object, "AP", label + " lost /AP"), "N", label + " lost /AP/N");
        assert(stream.isStream(), label + " appearance is not a stream.");
        assert(name(stream, "Type") === "XObject", label + " appearance lost its XObject type.");
        assert(name(stream, "Subtype") === "Form", label + " appearance lost its Form subtype.");
        checkArray(stream, "BBox", expectedBox, label + " appearance BBox");
        var decoded = stream.readStream().asString();
        assert(decoded === expectedStream, label + " original appearance stream changed.");
        return decoded;
    }
    function containsOutline(items, title) {
        for (var i = 0; i < items.length; ++i) {
            if (items[i].title === title) return true;
            if (items[i].down && containsOutline(items[i].down, title)) return true;
        }
        return false;
    }

    assert(scriptArgs.length === 1 && scriptArgs[0], "Supply exactly one native PDF export path.");
    // The second argument to native openDocument would be an accelerator path,
    // not a MIME type. Keep this filename-only native stream call intentional.
    var doc = Document.openDocument(scriptArgs[0]);
    assert(doc.isPDF(), "The exported document is not a PDF.");
    assert(!doc.needsPassword(), "Unexpected password on the exported fixture.");
    assert(!doc.wasRepaired(), "The exported PDF needed repair.");
    assert(doc.countPages() === 2, "The exported PDF lost a page.");

    var trailer = doc.getTrailer();
    var previousXrefOffset = number(get(trailer, "Prev", "Export is not an incremental PDF."), "Prev");
    var versionCount = doc.countVersions();
    assert(previousXrefOffset > 0 && Math.floor(previousXrefOffset) === previousXrefOffset, "Invalid incremental /Prev offset.");
    assert(versionCount >= 2, "The source revision was not retained.");

    var firstPageObject = doc.findPage(0);
    var secondPageObject = doc.findPage(1);
    checkArray(firstPageObject, "MediaBox", [0, 0, 612, 792], "Page 1 MediaBox");
    checkArray(firstPageObject, "CropBox", [20, 30, 592, 762], "Page 1 CropBox");
    checkArray(secondPageObject, "MediaBox", [0, 0, 612, 792], "Page 2 MediaBox");
    assert(number(get(secondPageObject, "Rotate"), "Rotate") === 90, "Page 2 rotation changed.");
    var firstObjects = values(get(firstPageObject, "Annots"), "Page 1 Annots");
    var secondObjects = values(get(secondPageObject, "Annots"), "Page 2 Annots");
    var allObjects = firstObjects.concat(secondObjects);
    assert(!allObjects.some(function (object) {
        var nm = object.get("NM");
        return nm !== null && nm.isString() && nm.asString() === "source-highlight";
    }), "The deleted source highlight was resurrected in live page annotations.");

    var originalNote = namedAnnotation(firstObjects, "source-note");
    assert(name(originalNote, "Subtype") === "Text", "The original note changed type.");
    near(opacity(originalNote), 0.35, "Original note opacity");
    checkArray(originalNote, "Rect", [380, 620, 400, 640], "Original note raw PDF Rect");
    checkArray(originalNote, "C", [1, 0, 0], "Original note color");
    assert(string(originalNote, "Contents") === "Original Folio note", "Original note text changed.");
    assert(string(originalNote, "FolioCustom") === "keep unknown annotation dictionary keys", "An unknown original annotation dictionary key was discarded.");
    var originalNoteAppearance = appearance(originalNote, "q 1 0 0 rg 0 0 m 20 0 l 10 20 l h f Q", [0, 0, 20, 20], "Original note");

    var addedHighlight = namedAnnotation(firstObjects, "native-added-highlight");
    assert(name(addedHighlight, "Subtype") === "Highlight", "New highlight changed type.");
    near(opacity(addedHighlight), 0.35, "New highlight default opacity");
    checkArray(addedHighlight, "QuadPoints", [80, 600, 200, 600, 80, 580, 200, 580], "New highlight raw PDF quads");
    checkArray(addedHighlight, "C", [1, 1, 0], "New highlight color");
    assert(string(addedHighlight, "Contents") === "Folio native exported highlight", "New highlight text changed.");

    var addedNote = namedAnnotation(firstObjects, "native-added-note");
    assert(name(addedNote, "Subtype") === "Text", "New note changed type.");
    near(opacity(addedNote), 1, "New note default opacity");
    checkArray(addedNote, "Rect", [420, 580, 440, 600], "New note raw PDF anchor bounds");
    checkArray(addedNote, "C", [1, 0, 0], "New note color");
    assert(string(addedNote, "Contents") === "Folio native exported note", "New note text changed.");

    var unseenHighlight = namedAnnotation(secondObjects, "unseen-highlight");
    assert(name(unseenHighlight, "Subtype") === "Highlight", "Unvisited highlight changed type.");
    near(opacity(unseenHighlight), 1, "Unvisited highlight opacity");
    checkArray(unseenHighlight, "Rect", [60, 645, 330, 674], "Unvisited highlight Rect");
    checkArray(unseenHighlight, "QuadPoints", [60, 674, 330, 674, 60, 645, 330, 645], "Unvisited highlight quads");
    checkArray(unseenHighlight, "C", [0, 1, 1], "Unvisited highlight color");
    assert(string(unseenHighlight, "Contents") === "Preserve unseen page", "Unvisited highlight text changed.");
    var unseenSquare = namedAnnotation(secondObjects, "unseen-square");
    assert(name(unseenSquare, "Subtype") === "Square", "Unvisited non-overlay annotation was lost.");
    checkArray(unseenSquare, "Rect", [450, 500, 500, 550], "Unvisited Square Rect");
    checkArray(unseenSquare, "C", [0, 0, 1], "Unvisited Square color");

    // getAnnotations() deliberately excludes Widgets. Inspect the raw catalog
    // and page annotation arrays so a hidden form field cannot pass unnoticed.
    var root = get(trailer, "Root");
    var fields = values(get(get(root, "AcroForm"), "Fields"), "AcroForm Fields");
    assert(fields.length === 1, "The original AcroForm field was lost or duplicated.");
    var widget = fields[0];
    assert(name(widget, "Subtype") === "Widget" && name(widget, "FT") === "Tx", "Original text field changed type.");
    assert(string(widget, "T") === "unseen-form", "Original field name changed.");
    assert(string(widget, "V") === "kept field value", "Original field value changed.");
    assert(number(get(widget, "F"), "Widget flags") === 36, "Hidden original field flags changed.");
    checkArray(widget, "Rect", [450, 400, 500, 420], "Original widget Rect");
    assert(secondObjects.filter(function (object) { return object.compare(widget) === 0; }).length === 1, "The original field is not retained exactly once in page 2 Annots.");
    var widgetAppearance = appearance(widget, "q .9 .9 .9 rg 0 0 50 20 re f Q", [0, 0, 50, 20], "Original hidden widget");

    assert(containsOutline(doc.loadOutline(), "Folio native second page"), "The original outline was lost.");
    var outline = get(get(root, "Outlines"), "First");
    assert(string(outline, "Title") === "Folio native second page", "Original outline title changed.");
    var destination = values(get(outline, "Dest"), "Outline destination");
    assert(destination.length === 2 && destination[1].asName() === "Fit", "Original outline destination mode changed.");
    assert(doc.findPageNumber(destination[0]) === 1, "Original outline no longer points to page 2.");

    var firstPage = doc.loadPage(0);
    var secondPage = doc.loadPage(1);
    var firstTypes = firstPage.getAnnotations().map(function (annotation) { return annotation.getType(); });
    var unseenTypes = secondPage.getAnnotations().map(function (annotation) { return annotation.getType(); });
    assert(firstTypes.filter(function (type) { return type === "Highlight"; }).length === 1, "Expected exactly one new page 1 highlight.");
    assert(firstTypes.filter(function (type) { return type === "Text"; }).length === 2, "Expected the original and new page 1 notes.");
    assert(unseenTypes.filter(function (type) { return type === "Highlight"; }).length === 1, "Unvisited highlight was lost or duplicated.");
    assert(unseenTypes.filter(function (type) { return type === "Square"; }).length === 1, "Unvisited Square was lost or duplicated.");
    [firstPage, secondPage].forEach(function (page, index) {
        var text = page.toStructuredText().asText();
        assert(text.indexOf("Folio native PDFKit selection search") >= 0, "Original text missing from page " + (index + 1) + ".");
        assert(text.indexOf("Words keep their original bounds.") >= 0, "Second text line missing from page " + (index + 1) + ".");
    });

    print(JSON.stringify({
        passed: true,
        engine: "MuPDF 1.28.1 native mutool",
        fileBacked: true,
        firstTypes: firstTypes,
        unseenTypes: unseenTypes,
        unseenNonOverlayPreserved: true,
        originalOpacityAndNamePreserved: true,
        addedHighlightDefaultOpacity: true,
        addedNoteDefaultOpacity: true,
        originalAppearanceAndWidgetPreserved: true,
        originalNoteAppearance: originalNoteAppearance,
        hiddenWidgetAppearance: widgetAppearance,
        originalNoteRect: numbers(get(originalNote, "Rect"), "Original note Rect"),
        addedNoteRect: numbers(get(addedNote, "Rect"), "Added note Rect"),
        widgetFlags: number(get(widget, "F"), "Widget flags"),
        cropRotationOutlineAndTextPreserved: true,
        removedSourceHighlightAbsent: true,
        incrementalVersions: versionCount,
        previousXrefOffset: previousXrefOffset,
        xrefBeyond2GiB: previousXrefOffset > 2147483647
    }));
}());
