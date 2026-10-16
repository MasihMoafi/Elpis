export type BrowserTab = { id:string; url:string; title:string; loading:boolean; error:string|null; canGoBack:boolean; canGoForward:boolean };
export type BrowserState = { visible:boolean; activeId:string|null; focusAddress:number; tabs:BrowserTab[] };
export type DesktopBrowser = {
  command:(action:string,data?:{id?:string;url?:string})=>Promise<BrowserState>;
  layout:(value:{bounds:{x:number;y:number;width:number;height:number};obscured:boolean})=>void;
  subscribe:(callback:(state:BrowserState)=>void)=>()=>void;
};
export type DesktopStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> & { saveItem?:(key:string,value:string)=>Promise<void>;onError:(callback:(message:string)=>void)=>()=>void };
declare global { interface Window { elpisDesktop?:{browser:DesktopBrowser;storage?:DesktopStorage;chooseFolder?:()=>Promise<string|null>;resolveFolder?:(folder:string)=>Promise<string>;openFile?:(target:string)=>Promise<void>;openFolder?:(folder:string)=>Promise<void>} } }
