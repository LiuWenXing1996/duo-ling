// 工具图标允许列表：可配置为 lucide 图标的名称（kebab-case，与 @lucide/vue 图标文件名一致）。
// 加载策略：此处用 import.meta.glob 静态匹配下面的路径字面量，构建时只生成列内图标的独立 chunk，
// 运行时仅加载「已配置到工具上 / 选择器中可见」的图标，避免全量引入 3554 个图标（约 7MB 产物）。
// 名称派生：LUCIDE_ICON_NAMES 由 glob 的 key 提取，与 glob 保持单一来源，不重复维护。
//
// 注意：import.meta.glob 参数必须是「直接字面量」（字符串/数组），不能经变量中转；
// 新增图标在下方模式的 `{...}` 里追加 `<名称>.mjs` 即可（名称须与 @lucide/vue/dist/esm/icons 下文件名一致）。
const lucideIconGlob = import.meta.glob(
  '../../../../node_modules/@lucide/vue/dist/esm/icons/{sparkle,star,heart,bookmark,tag,flag,bell,settings,sliders-horizontal,search,house,folder,folder-open,folder-plus,file,file-text,file-code,file-image,file-archive,file-check,file-plus,file-x,clipboard,clipboard-list,clipboard-check,list,list-checks,list-ordered,list-todo,check,circle-check,x,circle-x,plus,circle-plus,minus,circle-minus,info,triangle-alert,circle-alert,circle-question-mark,shield,shield-check,shield-alert,shield-x,lock,lock-open,key,key-round,fingerprint-pattern,eye,eye-off,pencil,square-pen,eraser,highlighter,undo,redo,copy,scissors,paperclip,link,external-link,download,upload,cloud-upload,cloud-download,refresh-cw,rotate-cw,rotate-ccw,save,send,share,share-2,funnel,trash,trash-2,archive,box,package,package-open,layers,layout-grid,layout-dashboard,columns-2,rows-2,table,panel-left,panel-right,app-window,monitor,smartphone,tablet,laptop,tv,headphones,keyboard,mouse,code,code-xml,braces,brackets,terminal,square-function,database,server,cpu,hard-drive,memory-stick,cloud,globe,git-branch,git-commit-horizontal,git-merge,git-pull-request,git-fork,bug,bot,brain,atom,flask-conical,test-tube,microscope,dna,puzzle,blocks,component,cable,plug,plug-zap,power,zap,chart-line,chart-bar,chart-pie,chart-area,chart-candlestick,chart-gantt,trending-up,trending-down,activity,gauge,kanban,clock,clock-arrow-up,calendar,calendar-days,calendar-check,calendar-plus,timer,alarm-clock,hourglass,mail,inbox,message-circle,message-square,message-square-text,phone,phone-call,printer,radio,play,pause,square-play,square-pause,square-stop,circle-play,circle-pause,volume,volume-1,volume-2,volume-x,music,mic,video,film,clapperboard,camera,image,images,map,map-pin,navigation,compass,landmark,building,building-2,factory,store,sun,moon,cloud-sun,umbrella,wind,waves-horizontal,droplet,flame,snowflake,leaf,tree-pine,flower,sprout,credit-card,wallet,coins,banknote,dollar-sign,percent,calculator,shopping-cart,shopping-bag,gift,crown,trophy,award,gem,car,truck,bike,plane,train-front,ship,rocket,fuel,arrow-up,arrow-down,arrow-left,arrow-right,arrow-up-right,arrow-up-left,arrow-down-right,arrow-down-left,chevron-up,chevron-down,chevron-left,chevron-right,chevrons-up,chevrons-down,chevrons-left,chevrons-right,ellipsis,ellipsis-vertical,menu,grip,maximize,minimize,zoom-in,zoom-out,move,crosshair,target,mouse-pointer,scan,qr-code,barcode,diamond,circle,square,triangle,hexagon,octagon,palette,paintbrush,swatch-book,wand-sparkles,spell-check,languages,book,book-open,library,graduation-cap,school,quote,newspaper,dices,joystick,toy-brick}.mjs'
)

/** 按名称取加载器；名称不在允许列表返回 undefined（由调用方回退） */
export function lucideIconLoader(name: string): (() => Promise<{ default: unknown }>) | undefined {
  const key = Object.keys(lucideIconGlob).find((k) => k.endsWith(`/${name}.mjs`))
  return key ? (lucideIconGlob[key] as () => Promise<{ default: unknown }>) : undefined
}

/** 全部允许的图标名称（从 glob key 派生，与 glob 单一来源，已按名称排序） */
export function lucideIconNames(): string[] {
  return Object.keys(lucideIconGlob)
    .map((k) => k.slice(k.lastIndexOf('/') + 1, -'.mjs'.length))
    .sort()
}
