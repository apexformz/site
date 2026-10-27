from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import math

OUT = Path(__file__).parent / 'figures'
OUT.mkdir(exist_ok=True)
NAVY = '#18344A'
TEAL = '#147D83'
INK = '#263B48'
MUTED = '#536B79'
PALE = '#EDF5F8'
LIGHT = '#D9E8EF'
WHITE = '#FFFFFF'
FONT = 'C:/Windows/Fonts/arial.ttf'
BOLD = 'C:/Windows/Fonts/arialbd.ttf'

def canvas(height):
    im = Image.new('RGB', (2200,height), WHITE)
    return im, ImageDraw.Draw(im)

def font(size=48,bold=False):
    return ImageFont.truetype(BOLD if bold else FONT,max(45,size))

def label(d,xy,s,size=48,color=INK,bold=False,anchor='mm',spacing=11,align='center'):
    d.multiline_text(xy,s,font=font(size,bold),fill=color,anchor=anchor,spacing=spacing,align=align)

def box(d,rect,s='',size=48,fill=PALE,outline=LIGHT,bold=False,color=INK,radius=20):
    d.rounded_rectangle(rect,radius=radius,fill=fill,outline=outline,width=3)
    if s:
        label(d,((rect[0]+rect[2])/2,(rect[1]+rect[3])/2),s,size,color,bold)

def arrow(d,points,color=TEAL,width=7,dashed=False,head=18):
    if dashed:
        for a,b in zip(points,points[1:]):
            length=math.dist(a,b)
            for st in range(0,int(length),25):
                en=min(st+14,length)
                p=(a[0]+(b[0]-a[0])*st/length,a[1]+(b[1]-a[1])*st/length)
                q=(a[0]+(b[0]-a[0])*en/length,a[1]+(b[1]-a[1])*en/length)
                d.line([p,q],fill=color,width=width)
    else:
        d.line(points,fill=color,width=width,joint='curve')
    a,b=points[-2:]
    ang=math.atan2(b[1]-a[1],b[0]-a[0])
    back=(b[0]-head*math.cos(ang),b[1]-head*math.sin(ang))
    d.polygon([b,(back[0]+head*.6*math.sin(ang),back[1]-head*.6*math.cos(ang)),(back[0]-head*.6*math.sin(ang),back[1]+head*.6*math.cos(ang))],fill=color)

def diamond(d,rect,s,size=48):
    x0,y0,x1,y1=rect
    d.polygon([((x0+x1)/2,y0),(x1,(y0+y1)/2),((x0+x1)/2,y1),(x0,(y0+y1)/2)],fill=PALE,outline=TEAL,width=4)
    label(d,((x0+x1)/2,(y0+y1)/2),s,size,INK,True)

def save(im,name):
    im.save(OUT/name,dpi=(320,320),optimize=True)

# 1 — Architecture: only one isolated domain is routed in a session.
im,d=canvas(1400)
box(d,(55,40,580,225),'MediaPipe\nPose landmarks',54,fill=NAVY,outline=NAVY,color=WHITE,bold=True)
box(d,(740,40,1460,225),'Human Motion Engine\nShared geometry + confidence',48,fill=NAVY,outline=NAVY,color=WHITE,bold=True)
box(d,(1620,40,2145,225),'Sport Router\nExplicit context',54,fill=TEAL,outline=TEAL,color=WHITE,bold=True)
arrow(d,[(580,130),(740,130)])
arrow(d,[(1460,130),(1620,130)])
arrow(d,[(1880,225),(1880,290),(365,290),(365,350)])
arrow(d,[(1100,290),(1100,350)])
arrow(d,[(1840,290),(1840,350)])
for x,name,stage in [(55,'TAEKWONDO','First migration'),(790,'BADMINTON','Candidate second sport'),(1525,'OTHER SPORT','Future extension')]:
    box(d,(x,350,x+620,885),fill=WHITE,outline=TEAL)
    d.rounded_rectangle((x+3,353,x+617,510),radius=17,fill=PALE)
    label(d,(x+310,400),name,50,NAVY,True)
    label(d,(x+310,465),stage,44,MUTED)
    box(d,(x+30,550,x+590,670),'Movement Engine\nOwn rules + phases',49,bold=True)
    box(d,(x+30,750,x+590,855),'Scoped references',48)
    arrow(d,[(x+310,750),(x+310,670)],width=6)
    arrow(d,[(x+310,885),(x+310,1000)],width=6)
label(d,(730,944),'Only the selected\nroute is active',45,TEAL,True,spacing=5)
box(d,(55,1000,2145,1160),'Shared analysis services\nExecute the selected movement policy and scoped references',52,bold=True)
arrow(d,[(750,1160),(750,1240)])
box(d,(370,1240,1130,1360),'Score + coaching',54,fill=TEAL,outline=TEAL,color=WHITE,bold=True)
arrow(d,[(1130,1300),(1390,1300)])
box(d,(1390,1240,2120,1360),'Athlete history',54,bold=True)
save(im,'architecture.png')

# 2 — Session decisions and asynchronous post-repetition work.
im,d=canvas(1290)
box(d,(55,40,660,190),'Select sport + movement\nSide + camera view',48,bold=True)
box(d,(825,40,1365,190),'Validate configuration',48,bold=True)
box(d,(1530,40,2145,190),'Capture frame',52,bold=True)
arrow(d,[(660,115),(825,115)])
arrow(d,[(1365,115),(1530,115)])
arrow(d,[(1838,190),(1838,290)])
diamond(d,(1655,290,2020,510),'Tracking\nadequate?',45)
box(d,(965,330,1465,475),'Setup guidance',49,bold=True)
arrow(d,[(1655,400),(1465,400)])
label(d,(1560,358),'No',44,TEAL,True)
arrow(d,[(1215,330),(1215,250),(1665,250),(1665,190)])
arrow(d,[(1838,510),(1838,610)])
label(d,(1910,560),'Yes',44,TEAL,True)
box(d,(1530,610,2145,760),'Motion + selected\nMovement Engine',49,bold=True)
arrow(d,[(1530,685),(1370,685)])
diamond(d,(945,565,1370,805),'Confidence\nadequate?',46)
label(d,(1158,525),'Movement / phase / reference',45,MUTED)
arrow(d,[(945,685),(750,685)])
label(d,(842,630),'Low',44,TEAL,True)
box(d,(55,610,750,760),'Display limited feedback\nNo precise correction',48,bold=True)
arrow(d,[(1158,805),(1158,945)])
label(d,(1325,891),'Sufficient',44,TEAL,True)
box(d,(845,945,1475,1090),'Score + coaching',52,fill=TEAL,outline=TEAL,color=WHITE,bold=True)
arrow(d,[(1475,1015),(1655,1015)])
box(d,(1655,945,2145,1090),'Display feedback',49,bold=True)
arrow(d,[(1900,1090),(1900,1155)],dashed=True)
box(d,(55,1155,2145,1255),'On repetition complete: asynchronous AQA + persistence  •  Outside the live frame hot path',44,fill=PALE,bold=True)
save(im,'session_flow.png')

# 3 — Retrieval must filter the semantic domain before computing neighbours.
im,d=canvas(1100)
levels=[(80,40,1320,170,'1   SPORT'),(170,235,1230,365,'2   MOVEMENT'),(260,430,1140,560,'3   PHASE'),(320,625,1080,795,'4   COMPATIBLE CONTEXT\nView · side · profile (optional)')]
for i,(x0,y0,x1,y1,s) in enumerate(levels):
    box(d,(x0,y0,x1,y1),s,48,fill=PALE if i else NAVY,outline=LIGHT if i else NAVY,color=INK if i else WHITE,bold=True)
    if i<3: arrow(d,[(700,y1),(700,levels[i+1][1])])
arrow(d,[(700,795),(700,870)])
box(d,(160,870,1240,1030),'Weighted nearest-neighbour matching\nWithin the filtered candidate set',50,fill=TEAL,outline=TEAL,color=WHITE,bold=True)
box(d,(1460,95,2135,425),fill=WHITE,outline=TEAL)
label(d,(1798,168),'RELEASED DATASETS',48,NAVY,True)
label(d,(1798,280),'Immutable versions\nTraceable reference IDs',48)
box(d,(1460,565,2135,955),fill=PALE,outline=LIGHT)
label(d,(1798,645),'ISOLATION RULE',48,NAVY,True)
label(d,(1798,775),'Never fall back across\nsport, movement\nor phase boundaries.',48)
save(im,'reference_scope.png')

# 4 — Geometric features, drawn as a schematic rather than an accuracy claim.
im,d=canvas(1160)
# landmark skeleton
pts={'head':(635,140),'neck':(635,255),'ls':(490,285),'rs':(770,315),'le':(325,430),'lw':(175,335),'re':(880,465),'rw':(1060,440),'lh':(540,660),'rh':(740,630),'lk':(455,845),'rk':(795,835),'la':(390,1070),'ra':(850,1065)}
segments=[('head','neck'),('neck','ls'),('neck','rs'),('ls','le'),('le','lw'),('rs','re'),('re','rw'),('ls','lh'),('rs','rh'),('lh','rh'),('lh','lk'),('lk','la'),('rh','rk'),('rk','ra')]
for a,b in segments:d.line([pts[a],pts[b]],fill=NAVY,width=13)
d.ellipse((588,92,682,186),fill=PALE,outline=NAVY,width=10)
for key,(x,y) in pts.items():
    if key!='head':d.ellipse((x-13,y-13,x+13,y+13),fill=WHITE,outline=TEAL,width=6)
# extended orientation axes
d.line([(385,273),(868,325)],fill=TEAL,width=5)
d.line([(430,676),(855,613)],fill=TEAL,width=5)
# torso vector
arrow(d,[(640,640),(630,340)],color=TEAL,width=8)
d.ellipse((620,513,660,553),fill=TEAL)
# angle wedge at elbow
d.arc((265,370,385,490),218,320,fill=TEAL,width=7)
label(d,(220,270),'Elbow angle',46,NAVY,True)
arrow(d,[(285,308),(316,370)],color=MUTED,width=4,head=12)
label(d,(320,160),'Shoulder orientation',46,NAVY,True)
arrow(d,[(490,199),(550,288)],color=MUTED,width=4,head=12)
label(d,(950,567),'Hip orientation',46,NAVY,True)
arrow(d,[(950,603),(850,615)],color=MUTED,width=4,head=12)
label(d,(260,620),'Torso vector',46,NAVY,True)
arrow(d,[(405,620),(623,503)],color=MUTED,width=4,head=12)
label(d,(970,790),'Body center',46,NAVY,True)
arrow(d,[(880,752),(657,550)],color=MUTED,width=4,head=12)
box(d,(1220,65,2140,280),'INPUT LANDMARKS\nx / y + optional z\nVisibility + timestamp',49,bold=True)
arrow(d,[(1680,280),(1680,365)])
box(d,(1220,365,2140,640),'GEOMETRY + DERIVATIVES\nJoint angles · body orientation\nVelocity · acceleration',49,bold=True)
arrow(d,[(1680,640),(1680,725)])
box(d,(1220,725,2140,1015),'MOTIONFRAME\nNormalized motion features\nTracking + visibility confidence\nPreserve available depth data',47,fill=TEAL,outline=TEAL,color=WHITE,bold=True)
label(d,(1680,1090),'Descriptive geometry schematic',45,MUTED)
save(im,'motion_geometry.png')

# 5 — At most two frames are retained in the live analysis path.
im,d=canvas(1160)
box(d,(70,115,600,355),'CAMERA FRAMES\nContinuous capture',50,bold=True)
arrow(d,[(600,235),(800,235)])
label(d,(700,173),'Idle',44,TEAL,True)
box(d,(800,115,1430,355),'ONE REQUEST IN FLIGHT\nCurrent frame analysis',46,fill=TEAL,outline=TEAL,color=WHITE,bold=True)
arrow(d,[(1430,235),(1620,235)])
box(d,(1620,115,2130,355),'LIVE FEEDBACK\nScore + coaching',49,bold=True)
arrow(d,[(335,355),(335,620),(800,620)])
label(d,(472,563),'While busy',46,TEAL,True)
box(d,(800,505,1430,750),'ONE PENDING FRAME\nKeep only the latest\nNewer replaces older',49,bold=True)
arrow(d,[(1430,620),(1535,620),(1535,425),(1115,425),(1115,355)])
label(d,(1835,615),'On completion:\ndispatch the latest\npending frame',47,INK,True)
label(d,(1115,815),'Bounded state: 1 in flight + 1 pending',48,NAVY,True)
arrow(d,[(1875,355),(2130,355),(2130,960),(1920,960)],dashed=True,width=6)
box(d,(70,915,1920,1085),'ON REPETITION COMPLETE\nAsynchronous AQA + persistence, outside the live frame hot path',48,fill=PALE,bold=True)
save(im,'backpressure.png')

# 6 — Implementation sequence; group labels indicate priority, not duration.
im,d=canvas(1100)
cols=[70,800,1530]
groups=[('P0  FOUNDATION',[(1,'Core extraction'),(2,'Engine interfaces')]),('P1  MIGRATION + VALIDATION',[(3,'Taekwondo package'),(4,'Movement isolation'),(5,'Phase references'),(6,'Score policies'),(7,'Coaching'),(8,'Athlete metrics')]),('P2  EXTENSION',[(9,'Second sport')])]
# 3 rows of sequential items, grouped with explicit badges.
items=[(1,'Core extraction','P0'),(2,'Engine interfaces','P0'),(3,'Taekwondo package','P1'),(6,'Score policies','P1'),(5,'Phase references','P1'),(4,'Movement isolation','P1'),(7,'Coaching','P1'),(8,'Athlete metrics','P1'),(9,'Second sport','P2')]
coords=[]
for idx,(num,name,priority) in enumerate(items):
    row,col=divmod(idx,3)
    x=cols[col];y=100+row*300
    coords.append((x,y))
    box(d,(x,y,x+600,y+210),fill=PALE,outline=LIGHT)
    d.ellipse((x+30,y+30,x+125,y+125),fill=TEAL)
    label(d,(x+78,y+77),str(num),50,WHITE,True)
    label(d,(x+480,y+76),priority,46,TEAL,True)
    label(d,(x+300,y+160),name,49,NAVY,True)
for a,b in [(0,1),(1,2),(5,4),(4,3),(6,7),(7,8)]:
    x,y=coords[a];xx,yy=coords[b]
    if xx>x:arrow(d,[(x+600,y+105),(xx,y+105)])
    else:arrow(d,[(x,y+105),(xx+600,yy+105)])
x,y=coords[2];xx,yy=coords[5];arrow(d,[(x+300,y+210),(xx+300,yy)])
x,y=coords[3];xx,yy=coords[6];arrow(d,[(x+300,y+210),(xx+300,yy)])
label(d,(1100,995),'P0  Foundation     •     P1  Migration + validation     •     P2  Extension',45,NAVY,True)
label(d,(1100,1060),'Priority groups indicate implementation order, not delivery dates.',44,MUTED)
save(im,'roadmap.png')

for path in sorted(OUT.glob('*.png')):
    with Image.open(path) as im:
        print(path.name, im.size)
