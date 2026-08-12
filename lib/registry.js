// The registry the shell renders itself from.
//
// Adding a tool is: write lib/tools/<id>.js exporting a TOOL, add a template
// fragment, and list it here. The sidebar, the route and the <h1> all come from
// this one list, so a tool cannot be reachable but unlisted, or listed under a
// name its page does not use.
//
// A tool is: { id, path, name, nav, group, icon, fragment, values }
//   group    the sidebar heading it sits under; tools sharing one are listed
//            together, in the order they appear below
//   path     as this app sees it; the gateway prefix is added by url()
//   name     the <h1> of the pane
//   nav      the sidebar label — says what it DOES, not just what it is called
//   icon     inner markup of a 24x24 stroke SVG
//   fragment the template file under templates/
//   values   substituted into that fragment
import { TOOL as pdf } from "./tools/pdf.js";

export const TOOLS = [pdf];

export const byPath = (path) => TOOLS.find((tool) => tool.path === path) || null;
