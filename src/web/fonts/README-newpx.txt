This package, based initially on pxfonts, provides many fixes and enhancements to that package, splitting it in two parts---newpxtext and newpxmath---which may be run independently of one another. It provides scaling, improved metrics, and other options. For proper operation, the packages require that the packages newtxmath, pxfonts and TeXGyrePagella be installed and their map files enabled. The text package now relies on an extension of the TeXGyrePagella Type1 fonts that is provided with this package. The accompanying MANIFEST-newpx.txt provides details of the extension as requested by GUST-FONT-LICENSE.txt

Current version: 1.541 2025-02-10

This material is subject to the LaTeX Project Public License. See http://www.ctan.org/license/lppl1.3
for the details of that license.

Changes in version 1.540
Corrected two lines in newpxtext.sty, replacing minzpltlf with minzpl. Same changes in documentation.

Changes in version 1.540
Removed a \fi from newpx.sty that was interfering with proper operation.

Changes in version 1.539
1. Corrected a bug in processing math Blackboard Bold in the case where the argument
is a macro other than \imath or \jmath. (Thanks, Romano Giannetti).
2. Corrected newpx and newpxtext to prevent irritating spurious errors and warnings.

Changes in version 1.538
Corrected a duplicate line in t1zpllf.fd and the \ProvidesFile name. (Thanks, Martin
Münch)


Changes in version 1.537
Modified the handling of the option scale[d] to newpx.sty so
that if works as expected for scaling math.

Changes in version 1.536
Corrected handling of sans and tt fonts in math mode using newpx.sty.

Changes in version 1.535
Moved all sups code from newpxtext.sty to superiors.sty, version 2,
leaving a stub in place to warn users of the associated newpxtext options
about the changes.

Changes in version 1.534
1. Made changes to a number of fd files to rework some incorrect \providefile entries. (Thanks Martin Münch.)
2. Added four declarations to newpxtext.sty of the form
	\DeclareFontFamilySubstitution{\encodingdefault}{zplLF}{zpllf}
so that the old names for font families would work as well as the new
lowercase forms.

Changes in version 1.533
1. Introduced a sequence of curly braces to replace standard braces if you specify
the option curlybraces to newtxmath.
2. Introduced three new math symbols: \laplace, \laplac and \dAlembertian. See the package  documentation for details.

Changes in version 1.532
1. Changed all references to zplTLF to zpltlf and updated docs to
reflect those changes.
2. Corrected a number of bugs in newpx.sty and newpxtext.sty that were
preventing the proper handling of calls to a unicode math font.

Changes in version 1.531
Corrected the footnote marker issues so the footnote modifications now
work as expected in all LaTeX engines, and in the standard and AMS
document classes. (Some small issues remain with KOMA classes.)

Changes in version 1.53
1. Addition of superior letters and figures distinct from and taller
than numerators.
2. Added superior versions of \textsection, \textparagraph, \textdagger,
\textdaggerdbl, \textbardbl, \textasteriskcentered, mainly for use as symbolic footnote
markers.
3. Addition of options to newpxtext: supsraised, supscale, supsLspaced, \supsRspaced and supscolor---all affecting how superiors are rendered.
4. Added modifications of some code from realscripts.sty for use in
legacy latex.
5. Corrections to documentation.
6. Added \textsfrac macro for stacked fractions.
7. Option scosf, which specifies oldstyle figure within small caps, has
been extended and now works in all LaTeX engines with both the \scshape
 switch and the macro \textsc{}.
8. Some correction to encoding and fd files.

Changes in version 1.521
Small change to newpxtext.sty so that option scosf works as expected under lualatex.

Changes in version 1.52
Rewrote the handling of footnotes. The code now works with all latex engines and with the KOMA classes as well as the basic latex classes. There are now added superior symbols that handle the latex and KOMA symbol footnote markers.

Changes in version 1.511
Removed mysterious sidebearing adjustments to uppercase Bbb letters in zplsym.tfm and zplbsym.tfm.

Changes in version 1.51
1. Corrected the zplnumr tfm files so that numerator figures work as expected.
2. Corrected newpxtext.sty so that:
	(i) removed the code for the useless option nofontspec;
	(ii) removed a duplicate option handler for defaultfeatures;
	(iii) limited the effect of defaultfeatures to the main font;
	(iv) reworked the footnote code so that KOMA based documents work as expected;
	(v) added option notextnu preventing a clash with babel/greek.
3. Added glyphs dotlessi.sc, dotlessj.sc, idotaccent.sc (with dot) and i.TRK (a copy of i) which is subbed for i in the Turkish localization. In smcp, i.TRK --> idotaccent.sc, dotlessi --> dotlessi.sc and dotlessj --> dotlessj.sc, and similarly in pcap. In c2sc, Idotaccent --> idotaccent.sc, and similarly in c2pc. Unlike i, i.TRK does not undergo any ligations, so that its dot is preserved. See TRK.fea for the localization feature which can be chosen after selecting Merge Feature Info in the FontForge file menu. The table it creates should be moved to the top of the tables, or at least ahead of c2sc, c2pc, smcp, pcap and the liga tables.
4. Corrected the glyph I.sc in bolditalic, removing spurious dot.
5. Added newpx.sty, which works in all latex engines, calling newpxtext.sty and newpxmath.sty as appropriate.
6. Added \textsfrac for building stacked fractions: \textfrac[2]{17}{32} renders somewhat like $2\frac{17}{32}.
7. Added a minzlt text font family that can serve as operators and for \mathrm, \mathit and so on. This allows newpxmath.sty to be loaded before the text font, whether it be [pdf]latex flavored newpxtext or a unicode text font.
8. Updated newpxmath to closer parity with newtxmath with modifications to the names of {C,c}olon related math symbols. Also, a fix for use with siunitx under option noOT1.
9. Modified newpxtext.sty to solve an issue with footnote markers in Title and \thanks. The key was to change the lines (recommended in the realscripts documentation dating back to 2016)
\renewcommand{\footnotemarkfont}{\normalfont} % for standard latex users
to
\renewcommand{\footnotemark}{\normalfont}
and
\setkomafont{footnotelabel}{\normalfont} % for KOMA users
to
\setkomafont{footnotereference}{\normalfont}

Changes in version 1.505
Corrected case of names of encoding files used for subs, sups, numr and dnom and modified newpx.map in a number of the affected items.

Changes in version 1.504
Modification to newpxtext.sty, adding a test that \theoremstyle is defined so as to avoid a problem with the kaobook class.

Changes in version 1.503
Larger small caps and slanted text are now working correctly thanks to changes in newtx encoding files.

Changes in version 1.502
Added the missing encoding files zpl_TOsF.enc, zpl_OsF.enc needed for ts1 tfms.

Changes in version 1.501
1. Added some fd files for small figures that were missing in version 1.5.
2. Corrected the package name in the .sty \ProvidesPackage macro.

Changes in version 1.5
1. Rewrote newpxtext.sty to work in all flavors of LaTeX and to implement the new macros and options.
2. Added real larger small caps, renaming the original small caps glyphs to be petite caps.
3. Reworked the \textfrac macro.
4. Complete revision of the documentation.
5. Added German capital sharp S and related glyphs, plus StylisticSet ss06 to map these to the old SS form.

Changes in version 1.427
Corrected a problem with rendering of larger small caps, caused by not making some definitions global in the relevant fd files.

Changes in version 1.426
1. Corrected a serious error in the code for parsing newpx-subs.tex for subscript corrections.
2. Added subscriptcorrectionfile, a new option to newpxmath, allows you to specify a different subscript correction file than the usual newpx-subs.tex.
3. Changed the documentation to modify the recommendation for handling newpx-subs.tex.
4. Small changes in px[b]miaX.{pfb,afm,tfm} to permit simpler fontinst scripts.

Changes in version 1.425
Corrections to examples in documentation, mostly about loading amsmath before amsthm. (Thanks Maurice Hansen.)

Changes in version 1.424
Modified definitions of \AmS and \AmSfont so the \AmS macro now works properly. (Thanks Maurice Hansen.)

Changes in version 1.423
1. Corrected weight of regular math accents, which were rendering in bold weight.
2. Corrected the bold symbol circledivide in bold weight. (It was inexplicably mirrored.)

Changes in version 1.422
Corrected for missing macro definition \npx@dfltfigurestyle in newpxtext.sty.

Changes in version 1.421
Changed the code in the main text font fd files along the lines of those in newtx.

Changes in version 1.42
1. Added a new text family, npxth, to accommodate the theorem font which is available only in regular weight, italic shape. (In previous versions, the theorem font was accessed as the slanted shape, which turned out to be a bad decision on my part.)
2. Added true slanted shapes and a new option, trueslanted, to newtxtext. If this option is not specified, newtxtext behaves exactly as in the previous version, with \textsl producing italic with upright punctation. If specified, \textsl produces true slanted text. It is strongly recommended to always use this option in order to get the correct behavior of figures in header text made after specifying \pagestyle{headings}. The only cost will be that you cannot use \textsl to invokee the theorem font. The substitute is \textth or, equivalently, \textthit.
3. Corrected the mismatched sizes of some extended math parentheses. (Thanks Kazuki Maeda.)

Changes in version 1.415
1. Added same corrections to math fonts as in newtx 1.641.
2. Added new lowercase letters to the math BB alphabet addressed by the option varbb.
3. Added an option "nohelv" to newpxtext to prevent the Helvetica clone loading as the sans serif text font.

Changes in version 1.414
Corrected zpl[b]sy,{tfm,vf} and pxbsys.pfb so that \nPerp renders as expected in both regular and bold.

Changes in version 1.413
Changes tiddle positions in f_i and f_f_i ligatures to match those on i, j.

Changes in version 1.412
1. Tiddles changed in math to match tex font tiddles.
1. Minor corrections to sups bold font.


Changes in version 1.411
Corrected fontdimen settings in zplexa, zplsyc and zplsym.

Changes in version 1.410
1. Made some corrections to the subspace offsets in symbol fonts to provide better alignment of subscripts and superscripts.
2. Reworked the dot positions for the five letters i, j, ij, iogonek and idotbelow, restoring the positions used in the original URW fonts and in earlier commercial versions, so that the top of the dot position aligns with the cap-height, allowing for curvature effects. (Thanks to Daniel Benjamin Miller for reporting this discrepancy.)

Changes in version 1.409
Changed some \Declare... macros to \re@Declare... in newpxmath.sty, matching recent changes in newtxmath.sty.

Changes in version 1.408
Other minor corrections.

Changes in version 1.407
Changed digits in NewPXBMI to bold tabular.

Changes in version 1.406
Fixed the footnote issues. Some files were missing from the distribution in previous versions.

Changes in version 1.405
Corrected the capitalization errors in newpx.map that were introduced in 1.404.

Changes in version 1.404
Corrected the entries in newpx.map, replacing the old sups lines with the versions that are correct for the newest version of newpx.

Changes in version 1.403
Corrected codes for \forall and \exists, which are now in their default positions in symbols.

Changes in version 1.402
Corrected newpx.map and added the correct version of the npxsups encoding files.

Changes in version 1.401
1. Changed name of file newpx.subs to newpx-subs.tex.
2. Placed the \pdfglyphtounicode lines in a conditional block in newpxmath.sty so it could continue to be used with other engines. (Thanks Hironobu Yamashita.)

Changes in version 1.40
1. Reworked the math italics to improve the rendering of some subscripts and superscripts, where formerly, overlaps could occur with superscripts like j, f, p and y with base shapes, such as D, that are round on the right. Increasing the left side-bearing of j, etc, helps with superscripts but makes those letters leave a large gap when used as subscripts.
2. Corrected and enhanced the subscriptcorrection option to newpxmath so that it now fixes the above problem. I regret that this option is incompatible with xy-pic, both depending on making _ an active character but with very different behaviors. Newpxmath will detect if xy is loaded and disable subscriptcorrection if so.
3. Added new script alphabets to math italics by extending the encoding from oml to full 256 slots, so they can be used without wasting math families.
4. Rearranged npxmia and zplsy. The user should not notice this, unless I have erred somewhere.
5. Provided an adaptive vector accent which matches the normal vector accent but extends as needed over its accentee. I've followed the usage of the esvect package, but changed its implementation.
6. Many small corrections to spacing and accent positioning.
7. Revised the superior letters fonts so they have appropriate unicode values.
8. As a result of these changes, documents generated using newpxmath and appropriate settings will validate PDF/A-1b. (Thanks to Ross Moore for providing the necessary files and details on this.) See the updated documentation to newpx for details.
9. Fixed error in lmxnpxexx.fd re fontdimens. (Thanks Ruixi Zhang.)
10. Added option fracspacing that modifies fontdimens 8 and 11 of the symbol font to values more appropriate to the newpx fonts. (Thanks Ruixi Zhang.)
11. Corrected AMS replacement font npxsym to fix \dalath, \mathbb{k}, \circledR and \circledS.

Changes in version 1.33
Modified newpxmath.sty to correct the macros involving selection of Blackboard Bold alphabets.

Changes in version 1.321
Modified the footnote marker code to remove a clash with the KOMA classes.

Changes in version 1.32
1. Reworked a number of math accents that appeared to lie too close to their accentees. The new versions are in symbols, leaving the one in operators unchanged.
2. Added a new math symbol, \transp, that can be used  for matrix transpose. See the documentation file for details.

Changes in version 1.319
Modified newpxtext.sty so that footnotes work as expected with the KOMAScript classes and with scrextend.sty. In prior versions, multiple footnote markers were not separated correctly under the KOMA option
footnotes=multiple.

Changes in version 1.318
Modified newpxtext.sty so that text figure styles are selected always in the \AtEndPreamble hook. (Formerly, using babel would prevent this.)

Changes in version 1.317
Redistributed a number of math glyphs from the symbol font in order to prevent bad rounding of heights that adversely affected the thickness of the horizontal bar on the radical.

Changes in version 1.316
Reworked the handling of the option theoremfont to newpxtext.sty so that the plain theorem style is defined only if amsthm is loaded before newpxtext.

Changes in version 1.315
Changed newpxtext.sty so amsthm not loaded unless option theoremfont is specified. (Thanks Claudio Marsan.)

Changes in version 1.314
Removed a stray { in newpxtext.sty. (Thanks Enrico Gregorio.)

Changes in version 1.313
1. Corrected definitions of \checkmark, \maltese, \circledR.
2. Improved the spacing of theoremfont, changing \topsep to \medskipamount.

Changes in version 1.312
Corrected the definition of the math accent \vec, undefining it before its new definition.

Changes in version 1.311
Corrected documentation concerning \setSYdimens and \setEXdimens.

Changes in version 1.31
Changes to math fonts in parallel with newtx 1.51.

Changes in version 1.301
Corrected an error in line 322 of newpxmath.sty 1.3. (Thanks Jens Hoelldampf.)

Changes in version 1.3
Changes to math fonts to bring newpxmath into parity with changes in newtxmath 1.5.

Changes in version 1.295
1. Generated with latest update to afm2tfm.
2. Documentation addition re using newpxmath in XeLaTeX and LuaLaTeX.

Changes in version 1.294
1. Changes to definitions of \widehat and \widetilde in newpxmath.sty so they bahave as expected in nested accents.
2. Reworked text metrics to repair heights of latters d and t in text mode, caused by an afm2tfm bug, now fixed.

Changes in version 1.293
Corrected << and >> ligatures in T1 and LY1. (Thanks, Claudio Beccari.) Version 1.452 or higher of newtx is required.

Changes in version 1.292
Reworked T_h and moved it to hlig (Historical Ligatures) table as its sole entry.

Changes in version 1.291
Reworked the liga lookup tables in all otf files so that are are now correctly parsed by fontspec. For reasons I can't explain, fontspec was not reading all liga entries in previous versions.

Changes in version 1.29
1. Added ligature T_h in each style.
2. Modified the kerning table in each style so that ligatures share the same kerning as their boundary glyphs. (These were missing in TeXGyrePagella. Thanks to Bastian Weith for alerting me to this issue.)

Changes in version 1.28
1. Changed + and = in math mode to new glyphs differing from the text + and =, more consistent in width and vertical axis with related math glyphs.
2. Modified definitions of \mathsterling and \mathcent. Values now taken from textcomp symbols.

Changes in version 1.27
Modified newpxmath.sty to mirror changes in newtxmath.sty. This makes \mathrm, \mathit and \mathnormal work as expected with Greek latters.

Changes in version 1.26
1. Modified zpl[b]exx.{tfm,vf} to follow changes in ntx[b]exx.{tfm,vf}.
2. Changed some Greek letters to be \mathalpha so that \mathnormal works as expected.

Changes in version 1.25
1. Moved ntx-*th-*.enc files to newtx so that newtx does not have any dependence on newpx.
2. Corrected newpx.map, adding entries that were previously in newpxtext.map, and removing the latter.

Changes in version 1.24
1. Added kerning entries between {V, W, Y} and {c, s, z} including accented forms.
2. Added otf files to package.

Changes in version 1.233
Ther only change is to zplr.pfb, which had a couple of glyphs which misbehaved when using Apple's LCD font smoothing. The new version does not have such problems.

Changes in version 1.232
1. Corrected definitions of \textsquare and \openbox in newtxmath. (Thanks, Jean-François Burnol.)
2. Added a new macro, \useproportional, to newpxtext.sty. It works analogously to \useosf, and may be useful if working with babel, where the option proportional to newpxtext should not be used if loading a math font.

Changes in version 1.231
Corrected definition of \tosfstyle in newpxtext.sty.

Changes in version 1.23
1. Reorganized 7 bit AMS math fonts A and B to occupy just one 8 bit font, perhaps reducing the number of math families in use. Math output should be unchanged.
2. Modified the default definition of \hbar, in case option noamssymbols was specified.
3. Version 1.43 or higher of newtx is required to be installed and enabled.

Changes in version 1.22
1. Kernings modified for some small caps and punctuation characters.
2. Added possibility of word spacing changes with options tighter, looser, spacing, stretch and shrink.
3. Added code to newpxtext.sty to detect use of babel and modify behavior accordingly.

Changes in version 1.211
Corrected errors in bfseries entries in *zplsups.fd. (Thanks Andrew Cashner.)

Changes in version 1.21
1. Corrected entries in newpx.map that were causing problems using largesc option in latex+dvips mode.
2. Corrected font definition files for ts1 so they now point to the correct tfm files.

Changes in version 1.201
Coorected handling of 'proportional' figure option.

Changes in version 1.2
1. Major upgrade to text fonts and support files, taking advantage of more parts of TeXGyrePagella and its extension, TeXGyrePagellaX. Extensions include:
2. Option "largesc" for larger small caps, same xheight as Adobe Palatino Small Caps.
3. Superior figures and letters in all styles via {\sustyle ...} or \textsu{}.
4. Four figure styles available. Default is tabular, lining. Other choices are proportional (or p), oldstyle (or  osf.)
5. New "theorem font" that mixes italic text with upright punctuation and figures, meant as a better font for "plain" theoremstyle theorem text. Option "theoremfont" to newpxtext sets this provided the appropriate package (eg, amsthm) has been loaded before newpxtext, otherwise plain has to be defined in your preamble along the lines specified in newpxtext.sty.
6. New option "babel" to newpxtext tries to work around problems with babel and \AtEndPreamble, but requires use of \useosf rather than simpler option "osf".
7. In newpxmath, corrected \varkappa and \varkappaup.

Changes in version 1.13
Added "frenchmath" option to newpxmath, so that Greek letters are upright and math italic capitals are replaced by upright capitals.

Changes in version 1.122
Corrected packaging errors in both main tree and tds.

Changes in version 1.121
Minor correction to tfm/vf for zpl[b]mi1 (math italic with alternate form of g.)

Changes in version 1.12
1. In tandem with newtxmath 1.23 (required), added macros and glyphs for mathaccents \widearc and \wideOarc. See the documentation in newtx for further details.
2. Added code to newpxtext.sty so that option osf does not affect math use of lining figures, making \useosf unnecessary but harmless. (Thanks to Pablo González for this fine suggestion.)

Changes in version 1.11
1. In tandem with newtxmath 1.22 (required), modified extendable parens to look more like fixed sizes.
2. Modified some symbol font metrics.

Changes in version 1.10
1. In tandem with newtx 1.21, corrected some issues with bold delimiters under bigdelims option.
2. Added a few symbols that, because of non-standard names, were missing from previous versions due to encoding issues.

Changes in version 1.09
In tandem with newtx 1.20, corrected some issues with extensible delimiters introduced inadvertently in newtx 1.18.

Changes in version 1.081
Small metric changes so that + and - in math mode have identical sizes.

Changes in version 1.08
1. Changed the default sans serif font from the pxfonts version of Helvetica (or a clone) to the TeX-Gyre Heros family, which is more developed. (In particular, its textasteriskcentered is much better.)
2. Changed a part of the footnote macro to prevent a subsequent space, adding instead a smaller horizontal space to prevent the footnote marker in the footer from colliding with its text.
3. Added a new option helvratio to allow changes in the scale for sans serif. If omitted, it defaults to .94 so that if, in effect, scaled=s, helvetica will be scaled to 94*s.

Changes in version 1.071
1. Corrected some encoding errors in symbol fonts, so \langle and \rangle work as expected.

Changes in version 1.07
1. Corrected some misbehaviors with bigdelims.
2. Added new math accents and macros in parallel to the newtx package where they are described in detail.

Changes in version 1.061
A number of metric changes, plus correction of < and > in math mode under bigdelims option.

Changes in version 1.06
1. Added a modified equal sign for use in math mode. The text font version did not match existing glyphs that use it as an extension glyph, as in long double arrows.
2. Modified the fontdimen parameters for several math fonts to correspond better to existing glyph shapes.

Changes in version 1.051:
Small changes to newpxtext.sty to correct handling of footnote markers in minipages and add a new option, defaultsups, which forces the package to ignore its own footnote markers.


Changes in version 1.05:
1. Corrected two errors in newpxmath.sty involving definitions of math delimiters <,>.
2. Added 4 new math glyphs as alternate forms of existing glyphs: \forallAlt, \existsAlt, \nexistsAlt, \emptysetAlt. See newtxdoc.pdf (NOT newpxdoc.pdf) for details.
3. Changed definition of \varnothing to load from lettersA instead of AMSb.

Changes in version 1.04:
1. Many changes to lettersA and largesymbols following the corresponding changes in the newtxmath package. Version 1.14 of the latter package must be enabled foro this package to function correctly.
2. Many changes to newpxmath.sty to bring it into greater conformity with the amsmath package, which it now requires.

Changes in version 1.03:
Corrected an issue with scaling newpxmath.

Changes in version 1.02
Minor changes except that version 1.01 inadvertently shipped without the final corrections to the math extension metrics.

Changes in version 1.01:
Aside from some minor changes, the math extension fonts are drawn from newtx version 1.11 which is substantially changed from the prior version, and which must be installed for proper math font rendering.

Installation:

Mac OS X: To install, open a Terminal window and cd to inside the downloaded TDS folder.

Method A (recommended): type

sudo cp -Rfp * /usr/local/texlive/texmf-local

then

sudo mktexlsr

then

sudo -H updmap-sys --enable Map=newpx.map

Method B: If you insist on making your font installations in your home folder, potentially making your personal installation become out of sync with updates to TeXLive, use instead

(i) if you checked Update for All Users in TeXLive utility

cp -Rfp * ~/Library/texmf

then

updmap --enable Map=newpx.map

(ii) otherwise

cp -Rfp * ~/Library/texmf

then

sudo updmap-sys --enable Map=newpx.map

Linux: Very similar to Mac OS X.

MikTeX: Copy the newpx.tds.zip to the root of the folder you use for personal additions to the TeX trees, open a command window, chdir to that folder, and type

unzip newtx.tds.zip
initexmf --update-fndb
initexmf --edit-config-file updmap

The latter command should open updmap.cfg in your default editor, commonly Notepad. Add the line

Map newpx.map

to updmap.cfg, save and close. Then, in the command window, type

initexmf --mkmaps

You can ignore error messages that may occur here. This should result in a properly enabled newpx.

Please send comments and bug reports or suggestions for improvement to

msharpe at ucsd dot edu
