export type ChannelMark = {
  name: string;
  lat: number;
  lng: number;
  kind: "port" | "starboard";
  label: string;
};
/** Buoys from the Khawr Abd Allah file, at their surveyed latitude and longitude. */
export const CHANNEL_MARKS: ChannelMark[] = [
  { name: "bouy1", lat: 29.68735004, lng: 48.73273335, kind: "starboard", label: "1" },
  { name: "bouy3", lat: 29.71383335, lng: 48.68044444, kind: "starboard", label: "3" },
  { name: "bouy2", lat: 29.70758332, lng: 48.67461668, kind: "port", label: "2" },
  { name: "bouy5", lat: 29.73983337, lng: 48.62933338, kind: "starboard", label: "5" },
  { name: "bouy4", lat: 29.73419996, lng: 48.62453333, kind: "port", label: "4" },
  { name: "bouy6", lat: 29.75936665, lng: 48.57608333, kind: "port", label: "6" },
  { name: "bouy7", lat: 29.76525000, lng: 48.57931670, kind: "starboard", label: "7" },
  { name: "Bouy9", lat: 29.78949998, lng: 48.52788890, kind: "starboard", label: "9" },
  { name: "bouy8", lat: 29.78166663, lng: 48.52083330, kind: "port", label: "8" },
  { name: "Bou10", lat: 29.80868329, lng: 48.47834999, kind: "port", label: "Bou10" },
  { name: "bouy11", lat: 29.81491662, lng: 48.47428333, kind: "starboard", label: "11" },
  { name: "Bouy13", lat: 29.83911666, lng: 48.43008336, kind: "starboard", label: "13" },
  { name: "Bouy12", lat: 29.83333330, lng: 48.42166665, kind: "port", label: "12" },
  { name: "Bouy14", lat: 29.85904999, lng: 48.37818336, kind: "port", label: "14" },
  { name: "Bouy15", lat: 29.86285004, lng: 48.38000000, kind: "starboard", label: "15" },
  { name: "Bouy17", lat: 29.88649998, lng: 48.33628338, kind: "starboard", label: "17" },
  { name: "Bouy16", lat: 29.88323334, lng: 48.33416665, kind: "port", label: "16" },
  { name: "Bouy19", lat: 29.92301665, lng: 48.29718338, kind: "starboard", label: "19" },
  { name: "BOuy21", lat: 29.96304998, lng: 48.25211663, kind: "starboard", label: "21" },
  { name: "Bouy20", lat: 29.96188338, lng: 48.24896667, kind: "port", label: "20" },
  { name: "Bouy23", lat: 30.00216665, lng: 48.21184996, kind: "starboard", label: "23" },
  { name: "bouy22", lat: 29.99896665, lng: 48.20935002, kind: "port", label: "22" },
  { name: "Bouy24", lat: 30.01073332, lng: 48.18471670, kind: "port", label: "24" },
  { name: "bouy25", lat: 30.02799999, lng: 48.15848330, kind: "starboard", label: "25" },
  { name: "bouy24A", lat: 30.02513336, lng: 48.15569995, kind: "port", label: "24A" },
  { name: "bouy27", lat: 30.03258330, lng: 48.13210000, kind: "starboard", label: "27" },
  { name: "bouy28", lat: 30.03200000, lng: 48.09133334, kind: "port", label: "28" },
  { name: "bouy29", lat: 30.03614998, lng: 48.09154996, kind: "starboard", label: "29" },
  { name: "bouy30", lat: 30.02515004, lng: 48.05791669, kind: "starboard", label: "30" },
  { name: "bouy32", lat: 29.99370000, lng: 48.02031670, kind: "port", label: "32" },
  { name: "bouy31", lat: 29.99753334, lng: 48.01834447, kind: "starboard", label: "31" },
  { name: "bouy24", lat: 29.99444999, lng: 47.99611663, kind: "port", label: "24" },
  { name: "bouy36", lat: 30.00056662, lng: 47.96633330, kind: "port", label: "36" },
  { name: "bouy35", lat: 30.00458335, lng: 47.96633337, kind: "starboard", label: "35" },
  { name: "bouy37", lat: 30.01525004, lng: 47.96086667, kind: "port", label: "37" },
  { name: "RED BOUY", lat: 30.03471858, lng: 47.95214517, kind: "port", label: "\u0623\u062d\u0645\u0631" },
  { name: "GREEN BOUY", lat: 30.03967244, lng: 47.95101412, kind: "starboard", label: "\u0623\u062e\u0636\u0631" },
];
