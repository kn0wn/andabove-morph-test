import { Vector2 } from "three";

/** Window cursor in pixels — used to map pointer into NDC for raycasting (replaces `Yr` in the bundle). */
export const globalCursor = {
  cursor: new Vector2(),
  screenWidth: typeof window !== "undefined" ? window.innerWidth : 1,
  screenHeight: typeof window !== "undefined" ? window.innerHeight : 1,
};

if (typeof window !== "undefined") {
  window.addEventListener("mousemove", (e) => {
    globalCursor.cursor.x = e.clientX;
    globalCursor.cursor.y = e.clientY;
  });
  window.addEventListener("resize", () => {
    globalCursor.screenWidth = window.innerWidth;
    globalCursor.screenHeight = window.innerHeight;
  });
}
