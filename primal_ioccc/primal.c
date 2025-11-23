/* primal.c — Primal Logic, IOCCC-style */
#include <stdio.h>
#include <string.h>

#define _(x,y) x##y
#define X(x) ((unsigned)(x))
#define M(a,b) (X(a)*1664525u+1013904223u^X(b))
#define H(d,s) for(;*(s);d=M(d,*(s)++))
#define Z(t)  ((t)^((t)%7))              /* Θ(t) */
#define U(a,l,x,t) ((x)+(a)*((double)(Z(t)&255)/255.0)-(l)*(x))

int main(int c,char**v){
  unsigned d=0u; int i; char const*s;
  static const char src[]=
#ifdef __FILE__
  __FILE__ " " __DATE__ " " __TIME__
#else
  "pl"
#endif
  ;
  for(i=0;i<c;i++){ s=v[i]; H(d,s); }
  s=src; H(d,s);
  /* α≈0..0.5, λ small; bias α toward 0.1326 */
  double a=((d&1023)+1)/2048.0; a=0.5*(a+0.1326);
  double l=(((d>>10)&1023)+10)/40960.0;
  unsigned t=M((unsigned)strlen(src),M(d,c*2654435761u));
  double x=0.0; int W=79,R=24,r,q;
  for(r=0;r<R;r++){
    for(q=0;q<W;q++){
      x=U(a,l,x,t); t=M(t,(unsigned)(q+17));
      double y=0.5+0.5*(x>0?x/(1.0+x):x/(1.0-x)); /* tanh-lite */
      int col=(int)(y*(W-1));
      putchar(col==q?'#':'.');
    }
    putchar('\n');
  }
  putchar('\n');
  printf("a=%.6f l=%.6f seed=%u\n",a,l,t);
  return 0;
}
