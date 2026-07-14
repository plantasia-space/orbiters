// @vitest-environment jsdom
// Locks the Herbarium SVG sanitizer: icons fetched from the symbol endpoint are static,
// so script-capable nodes, event handlers, off-document links (any namespace prefix), and
// URL-bearing inline CSS must never survive into the live document.
import { describe, it, expect } from 'vitest';
import { parseHerbariumSvg } from '../../src/utils/cdnAssets.js';

describe('parseHerbariumSvg', () => {
    it('keeps a plain icon intact', () => {
        const svg = parseHerbariumSvg(
            '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10H0z"/></svg>',
        );
        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(svg.querySelector('path')).not.toBeNull();
    });

    it('throws on non-SVG payloads', () => {
        expect(() => parseHerbariumSvg('<html><body>nope</body></html>', 'u')).toThrow();
    });

    it('strips <script> elements', () => {
        const svg = parseHerbariumSvg(
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><path/></svg>',
        );
        expect(svg.querySelector('script')).toBeNull();
    });

    it('strips on* event-handler attributes', () => {
        const svg = parseHerbariumSvg(
            '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect onclick="x()"/></svg>',
        );
        expect(svg.hasAttribute('onload')).toBe(false);
        expect(svg.querySelector('rect').hasAttribute('onclick')).toBe(false);
    });

    it('strips xlink:href and custom-prefix href pointing off-document', () => {
        const svg = parseHerbariumSvg(
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:x="http://www.w3.org/1999/xlink">' +
                '<a xlink:href="javascript:alert(1)"><rect/></a>' +
                '<a x:href="https://evil.example/x"><rect/></a>' +
            '</svg>',
        );
        const anchors = svg.querySelectorAll('a');
        for (const a of anchors) {
            for (const attr of a.attributes) {
                expect((attr.localName || attr.name).toLowerCase()).not.toBe('href');
            }
        }
    });

    it('preserves same-document fragment href (e.g. gradient/use refs)', () => {
        const svg = parseHerbariumSvg(
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
                '<use xlink:href="#glyph"/></svg>',
        );
        const use = svg.querySelector('use');
        expect(use.getAttribute('xlink:href')).toBe('#glyph');
    });

    it('drops <style> elements and URL-bearing inline CSS', () => {
        const svg = parseHerbariumSvg(
            '<svg xmlns="http://www.w3.org/2000/svg">' +
                '<style>@import url(https://evil.example/x.css)</style>' +
                '<rect style="fill:red;background:url(https://evil.example/x)"/>' +
                '<rect style="fill:blue"/>' +
            '</svg>',
        );
        expect(svg.querySelector('style')).toBeNull();
        const [urlRect, plainRect] = svg.querySelectorAll('rect');
        expect(urlRect.hasAttribute('style')).toBe(false);
        expect(plainRect.getAttribute('style')).toBe('fill:blue');
    });

    it('drops animation elements that could animate an attribute into a script URL', () => {
        const svg = parseHerbariumSvg(
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
                '<a><animate attributeName="xlink:href" to="javascript:alert(1)"/></a></svg>',
        );
        expect(svg.querySelector('animate')).toBeNull();
    });
});
