// A namespace, a base class and a derived one with a virtual method: what the debugger's
// call stack and variables views have to name and lay out for C++.
#include "shapes.h"

namespace geo {

class Shape {
 public:
  explicit Shape(int id) : id_(id) {}
  virtual ~Shape() {}
  virtual double area() const = 0;
  int id() const { return id_; }

 protected:
  int id_;
};

class Rect : public Shape {
 public:
  Rect(int id, double w, double h) : Shape(id), w_(w), h_(h) {}
  double area() const override { return w_ * h_; }

 private:
  double w_;
  double h_;
};

}  // namespace geo

extern "C" void __cxa_pure_virtual() {
  for (;;) {
  }
}

// No heap and no static destructors on a bare target.
void operator delete(void*, unsigned int) {}
extern "C" int __aeabi_atexit(void*, void (*)(void*), void*) { return 0; }
void* __dso_handle = nullptr;

static geo::Rect board(1, 2.0, 3.5);

extern "C" double shapes_area(void) {
  const geo::Shape& s = board;
  double a = s.area();
  return a * s.id();
}
